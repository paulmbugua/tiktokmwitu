import { createHmac, timingSafeEqual } from 'node:crypto';
import { origin } from './infra';
import type { Topup } from './gift-store';

const {
  PAYSTACK_SECRET_KEY, PAYSTACK_WEBHOOK_SECRET, MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_ENV, MPESA_TRANSACTION_TYPE, PAYMENT_API_ORIGIN,
} = process.env;
const daraja = MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const allowSandbox = !origin.startsWith('https:') || process.env.GIFTS_ALLOW_TEST_PAYMENTS === 'true';
export const paymentMethods = {
  card: !!PAYSTACK_SECRET_KEY && (allowSandbox || PAYSTACK_SECRET_KEY.startsWith('sk_live_')),
  mpesa: /^https:\/\//.test(PAYMENT_API_ORIGIN ?? '') && !!MPESA_CONSUMER_KEY && !!MPESA_CONSUMER_SECRET
    && /^\d{5,7}$/.test(MPESA_SHORTCODE ?? '') && !!MPESA_PASSKEY && (allowSandbox || MPESA_ENV === 'production'),
};

export class PaymentRejected extends Error {}

async function request<T>(url: string, authorization: string, body?: object) {
  const response = await fetch(url, {
    headers: { Authorization: authorization, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() as T };
}

export async function startCard(payment: Topup, email: string, liveCode?: string, liveRoom?: string) {
  const callback = new URL('/', origin);
  callback.searchParams.set('topup', payment.id);
  if (liveCode) callback.searchParams.set('live', liveCode);
  else if (liveRoom) callback.searchParams.set('room', liveRoom);
  const { status, body } = await request<{ status?: boolean; data?: { authorization_url?: string } }>(
    'https://api.paystack.co/transaction/initialize', 'Bearer ' + PAYSTACK_SECRET_KEY, {
      email, amount: String(payment.amount_kes * 100), currency: 'KES', channels: ['card'],
      reference: payment.id, callback_url: callback.href,
    });
  const url = body.data?.authorization_url;
  if (status >= 500 || status === 429) throw new Error('Paystack is temporarily unavailable.');
  if (!body.status || !url) throw new PaymentRejected('Card checkout could not start.');
  const target = new URL(url);
  if (target.origin !== 'https://checkout.paystack.com') throw new Error('Invalid Paystack checkout origin.');
  return { checkoutId: payment.id, checkoutUrl: target.href };
}

let accessToken: { value: string; until: number } | undefined;
async function mpesaAccess() {
  if (accessToken && accessToken.until > Date.now()) return accessToken.value;
  const auth = Buffer.from(MPESA_CONSUMER_KEY + ':' + MPESA_CONSUMER_SECRET).toString('base64');
  const { body } = await request<{ access_token?: string; expires_in?: string }>(
    daraja + '/oauth/v1/generate?grant_type=client_credentials', 'Basic ' + auth);
  if (!body.access_token) throw new Error('M-Pesa is temporarily unavailable.');
  accessToken = { value: body.access_token, until: Date.now() + Math.max(0, Number(body.expires_in ?? 3600) - 60) * 1000 };
  return accessToken.value;
}

function mpesaCredentials() {
  const nairobi = new Date(Date.now() + 3 * 3600000);
  const timestamp = nairobi.toISOString().slice(0, 19).replace(/\D/g, '');
  return { BusinessShortCode: MPESA_SHORTCODE, Timestamp: timestamp,
    Password: Buffer.from(MPESA_SHORTCODE + (MPESA_PASSKEY ?? '') + timestamp).toString('base64') };
}

function sameHex(expected: string, candidate: string | undefined) {
  return !!candidate && candidate.length === expected.length && /^[0-9a-f]+$/i.test(candidate)
    && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate, 'hex'));
}

const callbackProof = (id: string) => createHmac('sha256', MPESA_PASSKEY ?? '').update('mwitu-stk:' + id).digest('hex');
export const validMpesaCallback = (id: string, proof: string) => paymentMethods.mpesa && sameHex(callbackProof(id), proof);
export const mpesaPhoneDigest = (phone: string) => createHmac('sha256', MPESA_PASSKEY ?? '').update('mwitu-phone:' + phone).digest('hex');

export async function startMpesa(payment: Topup, phone: string) {
  const token = await mpesaAccess();
  const { status, body } = await request<{ ResponseCode?: string; CheckoutRequestID?: string }>(
    daraja + '/mpesa/stkpush/v1/process', 'Bearer ' + token, {
      ...mpesaCredentials(), TransactionType: MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
      Amount: payment.amount_kes, PartyA: phone, PartyB: MPESA_SHORTCODE, PhoneNumber: phone,
      CallBackURL: new URL('/api/gifts/webhooks/mpesa/' + payment.id + '/' + callbackProof(payment.id), PAYMENT_API_ORIGIN).href,
      AccountReference: 'MW' + payment.id.replaceAll('-', '').slice(0, 10), TransactionDesc: 'Mwitu Coins',
    });
  if (status >= 500 || status === 429) throw new Error('M-Pesa is temporarily unavailable.');
  if (String(body.ResponseCode) !== '0' || !body.CheckoutRequestID) throw new PaymentRejected('M-Pesa could not send a phone prompt.');
  return { checkoutId: body.CheckoutRequestID, checkoutUrl: null };
}

export async function verifyTopup(payment: Topup): Promise<'paid' | 'failed' | 'pending'> {
  if (payment.provider === 'card') {
    const { status, body } = await request<{ status?: boolean; data?: {
      status: string; reference: string; amount: number; currency: string; channel: string;
    } }>('https://api.paystack.co/transaction/verify/' + payment.id, 'Bearer ' + PAYSTACK_SECRET_KEY);
    const data = body.data;
    if (status !== 200 || !body.status || !data || data.reference !== payment.id) return 'pending';
    if (data.status === 'success') {
      return data.amount === payment.amount_kes * 100 && data.currency === 'KES' && data.channel === 'card' ? 'paid' : 'pending';
    }
    return ['failed', 'abandoned', 'reversed'].includes(data.status) ? 'failed' : 'pending';
  }
  if (!payment.checkout_id) return 'pending';
  const token = await mpesaAccess();
  const { status, body } = await request<{ ResultCode?: number | string; CheckoutRequestID?: string }>(
    daraja + '/mpesa/stkpushquery/v1/query', 'Bearer ' + token, {
      ...mpesaCredentials(), CheckoutRequestID: payment.checkout_id,
    });
  if (status !== 200 || body.CheckoutRequestID !== payment.checkout_id) return 'pending';
  const code = String(body.ResultCode ?? '');
  if (code === '0') return 'paid';
  return ['1', '1032', '1037', '2001'].includes(code) ? 'failed' : 'pending';
}

export function validCardWebhook(raw: Buffer, modern?: string, legacy?: string) {
  if (!paymentMethods.card) return false;
  if (modern && PAYSTACK_WEBHOOK_SECRET) {
    const entries = modern.split(',');
    const timestamp = entries.find(part => /^t=\d{10}$/.test(part))?.slice(2);
    if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    const expected = createHmac('sha512', PAYSTACK_WEBHOOK_SECRET).update(timestamp + '.').update(raw).digest('hex');
    return entries.some(part => /^v1=whk_[a-z0-9_-]+:/i.test(part) && sameHex(expected, part.split(':')[1]));
  }
  return sameHex(createHmac('sha512', PAYSTACK_SECRET_KEY!).update(raw).digest('hex'), legacy);
}
