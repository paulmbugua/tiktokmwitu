'use client';

import { ArrowLeft, Coins, Gift as GiftIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { send, useData } from './client';
import GiftWallet, { GiftArt, type Wallet } from './gift-wallet';

type Recipient = { id: string; name: string };
export type GiftEvent = { id: string; gift_id: string; name: string; sender: string; recipient: string; created_at: string };

export function GiftEffects({ events, now }: { events?: GiftEvent[]; now?: number }) {
  const seen = useRef(BigInt(0));
  const [queue, setQueue] = useState<GiftEvent[]>([]);
  const current = queue[0];
  useEffect(() => {
    if (!events?.length) return;
    const incoming = events.filter(event => BigInt(event.id) > seen.current && (now ?? Date.now()) - new Date(event.created_at).getTime() < 12000);
    const latest = BigInt(events.at(-1)!.id);
    if (latest > seen.current) seen.current = latest;
    if (incoming.length) setQueue(old => [...old, ...incoming.slice(-5)].slice(0, 7));
  }, [events, now]);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setQueue(old => old.slice(1)), 3000);
    return () => clearTimeout(timer);
  }, [current]);
  if (!current) return null;
  return <div className="live-gift-effect" data-gift={current.gift_id} key={current.id}>
    <div className="live-gift-halo"><GiftArt id={current.gift_id} /></div>
    <div className="live-gift-caption" role="status">
      <strong>{current.name}</strong><span>@{current.sender} sent a gift to {current.recipient}</span>
    </div>
  </div>;
}

export default function LiveGifts({ path, liveCode, recipients, refresh }: {
  path: string; liveCode: string; recipients: Recipient[]; refresh: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const wallet = useData<Wallet>('/gifts/wallet', revision);
  const [buy, setBuy] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState('');
  const [selectedGift, setSelectedGift] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const last = useRef<{ key: string; id: string } | null>(null);
  const recipient = recipients.find(person => person.id === selectedRecipient) ?? recipients[0];
  const gift = wallet?.data?.gifts.find(item => item.id === selectedGift) ?? wallet?.data?.gifts[0];
  const enough = !!gift && (wallet?.data?.balance ?? 0) >= gift.coins;
  if (buy) return <>
    <button className="link gift-back" onClick={() => { setBuy(false); setRevision(value => value + 1); }}><ArrowLeft size={16} /> Back to gifts</button>
    <GiftWallet liveCode={liveCode} />
  </>;
  return <div className="live-gift-shop">
    <div className="live-gift-balance">
      <strong><Coins size={18} /> {wallet?.data?.balance ?? 0} coins</strong>
      <button className="secondary" onClick={() => setBuy(true)}>Get coins</button>
    </div>
    <label>Send a gift to<select value={recipient?.id ?? ''} onChange={event => setSelectedRecipient(event.target.value)}>
      {recipients.map(person => <option value={person.id} key={person.id}>{person.name}</option>)}
    </select></label>
    <div className="gift-grid" role="group" aria-label="Gift collection">
      {wallet?.data?.gifts.map(item => <button key={item.id} type="button" className="gift-option"
        aria-pressed={gift?.id === item.id} onClick={() => { setSelectedGift(item.id); setNotice(''); }}>
        <GiftArt id={item.id} /><strong>{item.name}</strong><small>{item.coins} coins</small>
      </button>)}
    </div>
    {gift && <div className="gift-summary">
      <span>{gift.description}</span>
      <button className="primary" disabled={!recipient || !enough || sending} onClick={async () => {
        if (!recipient || !enough || sending) return;
        const key = recipient.id + ':' + gift.id;
        if (last.current?.key !== key) last.current = { key, id: crypto.randomUUID() };
        setSending(true);
        setError('');
        setNotice('');
        try {
          await send(path + '/gifts', 'POST', { gift: gift.id, recipientId: recipient.id, requestId: last.current.id });
          last.current = null;
          setNotice(gift.name + ' sent to ' + recipient.name + '.');
          setRevision(value => value + 1);
          refresh();
        } catch (error) { setError((error as Error).message); setRevision(value => value + 1); }
        finally { setSending(false); }
      }}><GiftIcon size={16} /> {sending ? 'Sending…' : 'Send · ' + gift.coins + ' coins'}</button>
      {!enough && <p className="hint">Get more coins to send this gift.</p>}
    </div>}
    {notice && <p role="status">{notice}</p>}
    {(error || wallet?.error) && <p className="error" role="alert">{error || wallet?.error}</p>}
  </div>;
}
