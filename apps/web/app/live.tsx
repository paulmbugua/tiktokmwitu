
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Radio } from 'lucide-react';
import { send, useData, type Person } from './client';
import Broadcast, { type Grant } from './live-broadcast';
import LiveInvitePlans from './live-invite-plans';
import { promotionAction, promotionEvent, usePlacementView, type Placement } from './promote';

type Listing = { enabled: boolean; rooms: Array<Person & { viewers: number; host_id: string }> };
type RoomPreview = Pick<Person, 'id' | 'handle' | 'display_name'> & { guestAccess: boolean };
type HostingEligibility = { followers: number; minimumFollowers: number; hasActivePlan: boolean; canStart: boolean };
const normalize = (value: string) => value.trim().replace(/[\s-]+/g, '').toUpperCase();
const shortCode = /^\d{6}$/;
const validCode = /^(?:\d{6}|[0-9A-F]{16})$/;

export default function Live({ user, sessionReady, initialCode, resume, roomId, signIn }: {
  user: Person | null; sessionReady: boolean; initialCode?: string; resume?: boolean; roomId?: string; signIn: (code?: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [code, setCode] = useState(normalize(initialCode ?? ''));
  const [codeInput, setCodeInput] = useState(initialCode ?? '');
  const resumed = useRef(false);
  const autoJoined = useRef('');
  const listing = useData<Listing>(grant || code ? null : '/live', revision);
  const eligibility = useData<HostingEligibility>(user && !grant && !code && !showPlans ? '/live/eligibility' : null, revision);
  const hosting = eligibility?.data;
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
    catch (error) {
      setError((error as Error).message);
      if (!id && !handoffCode) setRevision(value => value + 1);
    }
    finally { setPending(false); }
  }, [signIn, user]);

  const guestWatch = useCallback(async () => {
    setPending(true);
    setError('');
    try { setGrant(await send<Grant>('/live/handoff/' + code + '/watch', 'POST')); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }, [code]);

  useEffect(() => {
    if (!sessionReady || !shortCode.test(code) || !sharedRoom || grant || autoJoined.current===code) return;
    autoJoined.current=code;
    if (user) void join(sharedRoom.id,code);
    else if (sharedRoom.guestAccess) void guestWatch();
  }, [code, grant, guestWatch, join, sessionReady, sharedRoom, user]);

  useEffect(() => {
    if (!resume || resumed.current || !user || shortCode.test(code) || (!roomId && (!sharedRoom || !code))) return;
    resumed.current = true;
    void join(roomId ?? sharedRoom?.id, code || undefined);
  }, [code, join, sharedRoom, resume, roomId, user]);

  function browse() {
    setGrant(null);
    autoJoined.current='';
    setCode('');
    setCodeInput('');
    setError('');
    setRevision(value => value + 1);
    const url = new URL(window.location.href);
    url.searchParams.delete('live');
    window.history.replaceState(null, '', url);
  }

  function findCode(value: string) {
    const next=normalize(value);
    if (!validCode.test(next)) {setError('Enter the 6-digit LIVE code.');return;}
    setError('');
    setCode(next);
    const url=new URL(window.location.href);
    url.searchParams.set('live',next);
    window.history.replaceState(null,'',url);
  }

  if (grant && (user || grant.guest)) return <Broadcast key={grant.id} grant={grant} user={grant.guest ? null : user}
    signIn={() => signIn(grant.shareCode)} leave={browse} />;
  if (code) return <section className="live-handoff" aria-label="LIVE invitation">
    <h3>{sharedRoom ? sharedRoom.display_name + ' is live' : 'Join a LIVE'}</h3>
    {sharedRoom && <p className="hint">@{sharedRoom.handle} · Code {code}</p>}
    {!validCode.test(code) && <p className="error">Enter the 6-digit LIVE code.</p>}
    {validCode.test(code) && !preview && <p role="status">Finding this LIVE…</p>}
    {preview?.error && <p className="error" role="alert">{preview.error}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="arena-buttons">
      {sessionReady && sharedRoom?.guestAccess && !user && (!shortCode.test(code) || error) && <button className="primary" disabled={pending} onClick={() => void guestWatch()}>
        <Radio size={17} /> {pending ? 'Joining…' : 'Watch as guest'}
      </button>}
      {sessionReady && sharedRoom && (!shortCode.test(code) || error || (!user && !sharedRoom.guestAccess)) && <button className={!user && sharedRoom.guestAccess ? 'secondary' : 'primary'} disabled={pending} onClick={() => void join(sharedRoom.id, code)}>
        <Radio size={17} /> {pending ? 'Joining…' : !user ? 'Sign in to join LIVE' : user.handle === sharedRoom.handle ? 'Rejoin as host' : 'Join LIVE'}
      </button>}
      {pending&&shortCode.test(code)&&<p role="status">Joining {sharedRoom?.display_name}…</p>}
      <button className="secondary" disabled={pending} onClick={browse}>{shortCode.test(code)?'Enter a different code':'Browse LIVE'}</button>
    </div>
  </section>;
  if (showPlans && user) return <>
    <button className="link" onClick={() => {
      setShowPlans(false);
      setError('');
      setRevision(value => value + 1);
    }}>Back to LIVE</button>
    <LiveInvitePlans />
  </>;
  return <>
    <form className="live-code-form" onSubmit={event => {
      event.preventDefault();
      findCode(codeInput);
    }}>
      <label>Have a LIVE code?
        <input aria-label="LIVE room code" placeholder="6-digit code" value={codeInput} onChange={event => {
          const value=event.currentTarget.value;
          setCodeInput(value);
          if(validCode.test(normalize(value)))findCode(value);
        }} inputMode="numeric" maxLength={22} autoCapitalize="characters" autoCorrect="off" spellCheck={false} required />
      </label>
      <button className="primary" disabled={pending}><KeyRound size={16} /> Join LIVE</button>
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
    {listing?.data?.enabled && <>
      <button className="primary live-start" disabled={pending || (!!user && !hosting?.canStart)} onClick={() => void join()}><Radio size={18} /> Go live</button>
      {user && !hosting && <p className="hint" role="status">{eligibility?.error ?? 'Checking your LIVE eligibility…'}</p>}
      {hosting && !hosting.canStart && <>
        <p className="hint">You have {hosting.followers} of the {hosting.minimumFollowers} followers required to go LIVE. Both weekly invite plans let you go LIVE at any follower count.</p>
        <button className="secondary" onClick={() => setShowPlans(true)}>View weekly LIVE invite plans</button>
      </>}
      {hosting?.hasActivePlan && <p className="hint">Your weekly invite plan lets you go LIVE at any follower count.</p>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}
