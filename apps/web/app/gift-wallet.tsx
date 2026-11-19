'use client';

import { Coins, CreditCard, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, send, useData } from './client';

export type Gift = { id: string; name: string; coins: number; description: string };
type Purchase = {
  id: string; method: 'mpesa' | 'card'; kes: number; coins: number; status: 'pending' | 'paid' | 'failed';
  checkoutUrl: string | null; phonePrompt: boolean; createdAt: string;
};
export type Wallet = {
  balance: number; gifts: Gift[]; packs: { id: string; coins: number; kes: number }[];
  methods: Record<Purchase['method'], boolean>; purchases: Purchase[];
  history: { id: string; gift_id: string; coins: number; sent: boolean; handle: string }[];
  earnedMinor?: string;
};
type PurchaseStatus = { payment: Purchase; balance: number };
const amount = new Intl.NumberFormat('en-KE');

export function GiftArt({ id }: { id: string }) {
  return <span aria-hidden="true" className="gift-art" data-gift={id} />;
}

export default function GiftWallet({ liveCode, liveRoom, purchaseId }: { liveCode?: string; liveRoom?:string; purchaseId?: string }) {
  const [revision, setRevision] = useState(0);
  const wallet = useData<Wallet>('/gifts/wallet', revision);
  const [pack, setPack] = useState('100');
  const [method, setMethod] = useState<Purchase['method']>('mpesa');
  const [selected, setSelected] = useState(purchaseId);
  const [purchase, setPurchase] = useState<PurchaseStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const available = wallet?.data?.methods;
  const paymentMethod = available?.[method] ? method : available?.mpesa ? 'mpesa' : 'card';
  const active = purchase?.payment.id === selected ? purchase : undefined;

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const result = await api<PurchaseStatus>('/gifts/topups/' + selected, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPurchase(result);
        setError('');
        if (result.payment.status !== 'pending') {
          setRevision(value => value + 1);
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setError((error as Error).message);
      }
      timer = setTimeout(check, 5000);
    }
    void check();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selected]);

  return <div className="gift-wallet">
    <div className="gift-wallet-balance"><Coins size={21} /><strong>{amount.format(
      active?.payment.status === 'paid' ? active.balance : wallet?.data?.balance ?? 0)} coins</strong></div>
    {!!Number(wallet?.data?.earnedMinor)&&<p className="hint">Gift earnings · {(Number(wallet?.data?.earnedMinor)/100).toLocaleString('en-KE',{maximumFractionDigits:2})} coins after the 15% platform share</p>}
    {selected && !active && <p role="status">Checking your purchase…</p>}
    {active && <section className="gift-payment-status" aria-label="Purchase status">
      <strong>{active.payment.method === 'card' ? 'Card' : 'M-Pesa'} · KSh {active.payment.kes}</strong>
      <p role="status">{active.payment.status === 'paid' ? amount.format(active.payment.coins) + ' coins added.'
        : active.payment.status === 'failed' ? 'This payment did not complete.'
        : active.payment.method === 'mpesa'
          ? active.payment.phonePrompt ? 'Approve the M-Pesa request on your phone. We’ll update your balance after confirmation.'
            : 'Waiting for M-Pesa confirmation. Check your phone before starting another payment.'
          : 'Waiting for Paystack to confirm your card payment.'}</p>
      {active.payment.status === 'pending' && active.payment.checkoutUrl && <a className="secondary" href={active.payment.checkoutUrl}>Continue to Paystack</a>}
      <button className="link" onClick={() => { setSelected(undefined); setError(''); setRevision(value => value + 1); }}>
        {active.payment.status === 'pending' ? 'View wallet' : 'Done'}
      </button>
    </section>}
    {!selected && wallet?.data && (available?.mpesa || available?.card ? <form onSubmit={async event => {
      event.preventDefault();
      if (busy) return;
      const data = new FormData(event.currentTarget);
      const contact = String(data.get('contact') ?? '').trim();
      const fingerprint = JSON.stringify([paymentMethod, pack, contact]);
      if (request.current?.fingerprint !== fingerprint) request.current = { id: crypto.randomUUID(), fingerprint };
      setBusy(true);
      setError('');
      try {
        const result = await send<Purchase>('/gifts/topups', 'POST', {
          method: paymentMethod, pack, liveCode, liveRoom, requestId: request.current.id,
          ...(paymentMethod === 'mpesa' ? { phone: contact } : { email: contact }),
        });
        request.current = null;
        setSelected(result.id);
        if (result.checkoutUrl && result.status === 'pending') window.location.assign(result.checkoutUrl);
      } catch (error) { setError((error as Error).message); }
      finally { setBusy(false); }
    }}>
      <div className="gift-packs" role="group" aria-label="Coin packs">
        {wallet.data.packs.map(option => <button type="button" key={option.id} className="secondary" disabled={busy}
          aria-pressed={option.id === pack} onClick={() => setPack(option.id)}>
          <strong>{option.coins} coins</strong><small>KSh {option.kes}</small>
        </button>)}
      </div>
      <div className="gift-methods" role="group" aria-label="Payment method">
        <button type="button" className="secondary" aria-pressed={paymentMethod === 'mpesa'} disabled={!available.mpesa || busy}
          onClick={() => setMethod('mpesa')}><Smartphone size={16} /> M-Pesa</button>
        <button type="button" className="secondary" aria-pressed={paymentMethod === 'card'} disabled={!available.card || busy}
          onClick={() => setMethod('card')}><CreditCard size={16} /> Card</button>
      </div>
      <label key={paymentMethod}>{paymentMethod === 'mpesa' ? 'M-Pesa phone number' : 'Email for your card receipt'}
        <input name="contact" required type={paymentMethod === 'mpesa' ? 'tel' : 'email'}
          autoComplete={paymentMethod === 'mpesa' ? 'tel' : 'email'} maxLength={paymentMethod === 'mpesa' ? 18 : 200}
          placeholder={paymentMethod === 'mpesa' ? '07xx xxx xxx' : 'you@example.com'} disabled={busy} />
      </label>
      <button className="primary" disabled={busy}>{busy ? 'Starting payment…' : paymentMethod === 'mpesa' ? 'Send M-Pesa prompt' : 'Continue to card payment'}</button>
    </form> : <p className="hint">Coin purchases are currently unavailable.</p>)}
    {!selected && wallet?.data?.purchases.length ? <div className="gift-purchases">
      <h3>Recent purchases</h3>
      {wallet.data.purchases.map(item => <button type="button" key={item.id} className="row item"
        onClick={() => { setSelected(item.id); setError(''); }}>
        <span>{item.coins} coins · KSh {item.kes}</span><small>{item.status}</small>
      </button>)}
    </div> : null}
    {!selected && wallet?.data?.history.length ? <div className="gift-purchases">
      <h3>Gift activity</h3>
      {wallet.data.history.map(item => <div className="row" key={item.id}>
        <span>{wallet.data!.gifts.find(gift => gift.id === item.gift_id)?.name ?? 'Gift'}</span>
        <small>{item.sent ? 'To @' : 'From @'}{item.handle}</small>
      </div>)}
    </div> : null}
    {(error || wallet?.error) && <p className="error" role="alert">{error || wallet?.error}</p>}
  </div>;
}
