
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Radio } from 'lucide-react';
import { send, useData, type Person } from './client';
import Broadcast, { type Grant } from './live-broadcast';
import { promotionAction, promotionEvent, usePlacementView, type Placement } from './promote';

type Listing = { enabled: boolean; rooms: Array<Person & { viewers: number; host_id: string }> };
type RoomPreview = Pick<Person, 'id' | 'handle' | 'display_name'> & { guestAccess: boolean };
const normalize = (value: string) => value.trim().replace(/[\s-]+/g, '').toUpperCase();
const validCode = /^[0-9A-F]{16}$/;

export default function Live({ user, initialCode, resume, roomId, signIn }: {
  user: Person | null; initialCode?: string; resume?: boolean; roomId?: string; signIn: (code?: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState(normalize(initialCode ?? ''));
  const [codeInput, setCodeInput] = useState(initialCode ?? '');
  const resumed = useRef(false);
  const listing = useData<Listing>(grant || code ? null : '/live', revision);
  const placement=useData<Placement|null>(!grant&&!code?'/promote/placement?surface=live':null)?.data;
  const promoted=listing?.data?.rooms.find(room=>room.id===placement?.liveId);
  const [adRef,setAdRef]=useState<HTMLElement|null>(null);
  usePlacementView(adRef,promoted?placement:undefined);
  const preview = useData<RoomPreview>(!grant && validCode.test(code) ? '/live/handoff/' + code : null, revision);
  const sharedRoom = preview?.data;
  useEffect(() => {
    if (grant || code || listing?.data?.enabled === false) return;
    const timer = setInterval(() => setRevision(value => value + 1), 7000);
    return () => clearInterval(timer);
  }, [code, grant, listing?.data?.enabled]);

  const join = useCallback(async (id?: string, handoffCode?: string) => {
    if (!user) { signIn(handoffCode); return; }
    setPending(true);
    setError('');
    try { setGrant(await send<Grant>(handoffCode ? '/live/handoff/'+handoffCode+'/join' : id ? '/live/' + id + '/join' : '/live/start', 'POST')); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }, [signIn, user]);

  async function guestWatch() {
    setPending(true);
    setError('');
    try { setGrant(await send<Grant>('/live/handoff/' + code + '/watch', 'POST')); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  useEffect(() => {
    if (!resume || resumed.current || !user || (!roomId && (!sharedRoom || !code))) return;
    resumed.current = true;
    void join(roomId ?? sharedRoom?.id, code || undefined);
  }, [code, join, sharedRoom, resume, roomId, user]);

  function browse() {
    setGrant(null);
    setCode('');
    setCodeInput('');
    setError('');
    setRevision(value => value + 1);
    const url = new URL(window.location.href);
    url.searchParams.delete('live');
    window.history.replaceState(null, '', url);
  }

  if (grant && (user || grant.guest)) return <Broadcast key={grant.id} grant={grant} user={grant.guest ? null : user}
    signIn={() => signIn(grant.shareCode)} leave={browse} />;
  if (code) return <section className="live-handoff" aria-label="LIVE invitation">
    <h3>{sharedRoom ? sharedRoom.display_name + ' is live' : 'Join a LIVE'}</h3>
    {sharedRoom && <p className="hint">@{sharedRoom.handle} · Code {code}</p>}
    {!validCode.test(code) && <p className="error">Enter a 16-character LIVE code.</p>}
    {validCode.test(code) && !preview && <p role="status">Finding this LIVE…</p>}
    {preview?.error && <p className="error" role="alert">{preview.error}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="arena-buttons">
      {sharedRoom?.guestAccess && !user && <button className="primary" disabled={pending} onClick={() => void guestWatch()}>
        <Radio size={17} /> {pending ? 'Joining…' : 'Watch as guest'}
      </button>}
      {sharedRoom && <button className={!user && sharedRoom.guestAccess ? 'secondary' : 'primary'} disabled={pending} onClick={() => void join(sharedRoom.id, code)}>
        <Radio size={17} /> {pending ? 'Joining…' : !user ? 'Sign in to join LIVE' : user.handle === sharedRoom.handle ? 'Rejoin as host' : 'Join LIVE'}
      </button>}
      <button className="secondary" disabled={pending} onClick={browse}>Browse LIVE</button>
    </div>
  </section>;
  return <>
    <form className="inline" onSubmit={event => {
      event.preventDefault();
      const next = normalize(codeInput);
      if (!validCode.test(next)) { setError('Enter a 16-character LIVE code.'); return; }
      setError('');
      setCode(next);
      const url = new URL(window.location.href);
      url.searchParams.set('live', next);
      window.history.replaceState(null, '', url);
    }}>
      <input aria-label="LIVE room code" placeholder="Enter a LIVE code" value={codeInput} onChange={event => setCodeInput(event.target.value)}
        maxLength={22} autoCapitalize="characters" autoCorrect="off" spellCheck={false} required />
      <button className="secondary" disabled={pending}><KeyRound size={16} /> Find LIVE</button>
    </form>
    <div className="list">
      {promoted&&placement&&<div className="sponsored-live" ref={setAdRef}>
        <small>Sponsored LIVE</small>
        <div className="commerce-heading"><strong>{promoted.display_name}</strong><button className="secondary" disabled={pending} onClick={()=>{
          void promotionEvent(placement,'click');void join(promoted.id);
        }}>{promotionAction(placement)}</button></div>
      </div>}
      {listing?.data?.rooms.filter(room=>room.id!==promoted?.id).map(room => <button key={room.id} className="row item" disabled={pending} onClick={() => void join(room.id)}>
        <Radio size={20} /><div><strong>{room.display_name}</strong><p>@{room.handle} · {room.viewers} watching</p></div>
      </button>)}
      <p className="hint">{listing?.error ?? (!listing?.data ? 'Checking for broadcasts…'
        : !listing.data.enabled ? 'Live broadcasts are unavailable.'
        : listing.data.rooms.length === 0 ? 'No one is live right now.' : '')}</p>
    </div>
    {listing?.data?.enabled && <button className="primary live-start" disabled={pending} onClick={() => void join()}><Radio size={18} /> Go live</button>}
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}
