import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { db, parse, requireUser, uuid } from './infra';
import { coinBalance, coinPacks, creditTopup, giftCatalog, type Topup } from './gift-store';
import { mpesaPhoneDigest, paymentMethods, PaymentRejected, startCard, startMpesa, validCardWebhook, validMpesaCallback, verifyTopup } from './gift-providers';
import { inviteCodePattern } from './live-invites';

const phoneSchema = z.string().trim().max(18).transform(value => value.replace(/[\s-]/g, '').replace(/^\+/, '').replace(/^0/, '254'))
  .refine(value => /^254[17]\d{8}$/.test(value), 'Enter a Kenyan mobile number.');
const topupFields = {
  pack: z.enum(['100', '300', '700', '1000', '2000']),
  requestId: z.uuid(),
  liveCode: z.string().regex(inviteCodePattern).optional(),
  liveRoom: z.uuid().optional(),
};
const topupInput = z.discriminatedUnion('method', [
  z.object({ ...topupFields, method: z.literal('card'), email: z.email().trim().max(200) }),
  z.object({ ...topupFields, method: z.literal('mpesa'), phone: phoneSchema }),
]);

function showTopup(payment: Topup) {
  return { id: payment.id, method: payment.provider, kes: payment.amount_kes, coins: payment.coins,
    status: payment.status, checkoutUrl: payment.checkout_url, phonePrompt: !!payment.checkout_id,
    createdAt: payment.created_at };
}

async function reconcilePayment(payment: Topup) {
  if (!paymentMethods[payment.provider]) return;
  try {
    const result = await verifyTopup(payment);
    if (result === 'paid') await creditTopup(payment);
    else if (result === 'failed') await db.query("UPDATE gift_topups SET status='failed',checkout_url=NULL WHERE id=$1 AND status='pending'", [payment.id]);
  } catch {
    // A timeout or provider error leaves the order pending for the next attempt.
  }
}

async function claimTopup(id: string) {
  const { rows: [payment] } = await db.query<Topup>(`
    UPDATE gift_topups SET next_check_at=now()+interval '25 seconds'
    WHERE id=$1 AND status='pending' AND next_check_at<=now() AND (provider='card' OR checkout_id IS NOT NULL)
    RETURNING *`, [id]);
  if (payment) await reconcilePayment(payment);
}

let sweeping = false;
export async function reconcileTopups() {
  if (sweeping || !Object.values(paymentMethods).some(Boolean)) return;
  sweeping = true;
  try {
    const { rows } = await db.query<Topup>(`
      WITH due AS (SELECT id FROM gift_topups WHERE status='pending' AND next_check_at<=now()
        AND (provider='card' OR checkout_id IS NOT NULL)
        AND created_at>now()-interval '30 days'
        ORDER BY next_check_at LIMIT 12 FOR UPDATE SKIP LOCKED)
      UPDATE gift_topups p SET next_check_at=now()+CASE
        WHEN p.created_at>now()-interval '5 minutes' THEN interval '25 seconds'
        WHEN p.created_at>now()-interval '1 hour' THEN interval '3 minutes'
        ELSE interval '4 hours' END FROM due WHERE p.id=due.id RETURNING p.*`);
    await Promise.all(rows.map(reconcilePayment));
  } catch (error) {
    console.error('Coin purchase reconciliation failed', error);
  } finally { sweeping = false; }
}

@Controller('gifts')
export class GiftPaymentsController {
  @Get('wallet')
  async wallet(@Req() req: Request) {
    const user = await requireUser(req);
    const [balance, purchases, history, earnings] = await Promise.all([
      coinBalance(user.id),
      db.query<Topup>('SELECT * FROM gift_topups WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 12', [user.id]),
      db.query(`
        SELECT g.id::text,g.gift_id,g.coins,g.performer_minor,g.created_at,(g.sender_id=$1) AS sent,
          CASE WHEN g.sender_id=$1 THEN r.handle ELSE s.handle END AS handle
        FROM live_gifts g JOIN users s ON s.id=g.sender_id JOIN users r ON r.id=g.recipient_id
        WHERE g.sender_id=$1 OR g.recipient_id=$1 ORDER BY g.id DESC LIMIT 12`, [user.id]),
      db.query<{ total: string }>('SELECT COALESCE(sum(performer_minor),0)::text AS total FROM live_gifts WHERE recipient_id=$1', [user.id]),
    ]);
    return { balance, gifts: giftCatalog, packs: coinPacks, methods: paymentMethods,
      purchases: purchases.rows.map(showTopup), history: history.rows, earnedMinor: earnings.rows[0].total };
  }

  @Post('topups')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  async start(@Req() req: Request, @Body() body: unknown) {
    const user = await requireUser(req);
    const input = parse(topupInput, body);
    if (!paymentMethods[input.method]) throw new ServiceUnavailableException('This payment method is unavailable.');
    const pack = coinPacks.find(pack => pack.id === input.pack)!;
    const { rows: [created] } = await db.query<Topup>(`
      INSERT INTO gift_topups(user_id,request_id,provider,amount_kes,coins,mpesa_phone_digest) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(user_id,request_id) DO NOTHING RETURNING *`, [
      user.id, input.requestId, input.method, pack.kes, pack.coins,
      input.method === 'mpesa' ? mpesaPhoneDigest(input.phone) : null,
    ]);
    if (!created) {
      const { rows: [existing] } = await db.query<Topup>('SELECT * FROM gift_topups WHERE user_id=$1 AND request_id=$2', [user.id, input.requestId]);
      if (existing.provider !== input.method || existing.amount_kes !== pack.kes) throw new ConflictException('Start a new purchase for these options.');
      return showTopup(existing);
    }
    try {
      const checkout = input.method === 'mpesa' ? await startMpesa(created, input.phone) : await startCard(created, input.email, input.liveCode, input.liveRoom);
      const { rows: [payment] } = await db.query<Topup>(
        'UPDATE gift_topups SET checkout_id=COALESCE(checkout_id,$2),checkout_url=$3 WHERE id=$1 RETURNING *',
        [created.id, checkout.checkoutId, checkout.checkoutUrl]);
      return showTopup(payment);
    } catch (error) {
      if (error instanceof PaymentRejected) {
        await db.query("UPDATE gift_topups SET status='failed' WHERE id=$1 AND status='pending'", [created.id]);
        return showTopup({ ...created, status: 'failed' });
      }
      return showTopup(created);
    }
  }

  @Get('topups/:id')
  async status(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const find = async () => (await db.query<Topup>('SELECT * FROM gift_topups WHERE id=$1 AND user_id=$2', [id, user.id])).rows[0];
    const payment = await find();
    if (!payment) throw new NotFoundException('Purchase not found.');
    if (payment.status === 'pending') await claimTopup(id);
    return { payment: showTopup((await find())!), balance: await coinBalance(user.id) };
  }

  @Post('webhooks/card')
  @HttpCode(200)
  async cardCallback(@Req() req: RawBodyRequest<Request>, @Body() body: { event?: unknown; data?: { reference?: unknown } }) {
    if (!req.rawBody || !validCardWebhook(req.rawBody, req.get('paystack-signature'), req.get('x-paystack-signature'))) {
      throw new ForbiddenException();
    }
    const ref = z.uuid().safeParse(body?.data?.reference);
    if (body?.event === 'charge.success' && ref.success) {
      await db.query("UPDATE gift_topups SET next_check_at=now() WHERE id=$1 AND provider='card' AND status='pending'", [ref.data]);
    }
    return { ok: true };
  }

  @Post('webhooks/mpesa/:id/:proof')
  @HttpCode(200)
  async mpesaCallback(@Param('id') raw: string, @Param('proof') proof: string, @Body() body: unknown) {
    const id = uuid(raw);
    if (!validMpesaCallback(id, proof)) throw new ForbiddenException();
    const received = z.object({ Body: z.object({ stkCallback: z.object({
      CheckoutRequestID: z.string().min(1).max(100),
      ResultCode: z.union([z.number(), z.string()]).optional(),
      CallbackMetadata: z.object({ Item: z.array(z.object({ Name: z.string(), Value: z.unknown() })).max(20) }).optional(),
    }) }) }).safeParse(body);
    if (received.success) {
      const callback = received.data.Body.stkCallback;
      const details = callback.CallbackMetadata?.Item;
      const phone = phoneSchema.safeParse(String(details?.find(item => item.Name === 'PhoneNumber')?.Value ?? ''));
      const amount = Number(details?.find(item => item.Name === 'Amount')?.Value);
      // Recover a lost STK response only from that order's signed callback with matching details.
      // The authenticated Daraja query still decides whether to credit the coins.
      const recovery = String(callback.ResultCode) === '0' && phone.success && Number.isSafeInteger(amount) && amount > 0;
      await db.query(`
        UPDATE gift_topups SET next_check_at=now(),checkout_id=COALESCE(checkout_id,$2)
        WHERE id=$1 AND provider='mpesa' AND status='pending'
          AND (checkout_id=$2 OR (checkout_id IS NULL AND amount_kes=$3 AND mpesa_phone_digest=$4))`, [
        id, callback.CheckoutRequestID, recovery ? amount : null, recovery ? mpesaPhoneDigest(phone.data) : null,
      ]);
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
