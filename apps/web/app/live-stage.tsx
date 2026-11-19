'use client';

import { CameraOff, LayoutGrid, Star, UserPlus } from 'lucide-react';
import { LocalVideoTrack, Track, TrackEvent } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { useData, type Person } from './client';

export type StageSeat = { id: string; user_id: string; display_name: string; handle: string; on_stage: boolean };
export type StageState = { spotlight: string | null; fullscreen: boolean; capacity: number; seats: StageSeat[];
  requests?: Person[]; openSeats?: number };
export type StageCommand =
  | { action: 'invite'; handle: string }
  | { action: 'request' | 'cancel-request' }
  | { action: 'approve-request' | 'decline-request'; userId: string }
  | { action: 'accept' | 'decline' | 'leave' | 'remove'; seatId: string }
  | { action: 'spotlight'; userId: string | null }
  | { action: 'layout'; cards: 2|4|6|8 }
  | { action: 'fullscreen'; userId: string; enabled: boolean };

export function StageTile({ name, track, identity, featured, host }: {
  name: string; track?: Track; identity: string; featured: boolean; host: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const local = track instanceof LocalVideoTrack;
  const facing = local ? track.mediaStreamTrack.getSettings().facingMode : undefined;
  useEffect(() => {
    const element = video.current;
    if (!element || !track) return;
    const update = () => setMuted(track.isMuted);
    update();
    track.on(TrackEvent.Muted, update).on(TrackEvent.Unmuted, update);
    track.attach(element);
    return () => {
      track.off(TrackEvent.Muted, update).off(TrackEvent.Unmuted, update);
      track.detach(element);
    };
  }, [track]);
  return <div className={'arena-tile' + (featured ? ' featured' : '')} data-stage-person={identity} aria-label={name}>
    {(!track || muted) && <div className="arena-camera-placeholder" aria-label={track ? 'Camera off' : 'Waiting for camera'}>
      <CameraOff size={21} />
    </div>}
    {track && <div className={muted ? 'arena-camera-muted' : undefined}>
      <video ref={video} playsInline muted={local} className={local && (!facing || facing === 'user') ? 'self-preview' : undefined} />
    </div>}
    <span className={host?'arena-host-badge':undefined}>{host?'Host':name}</span>
  </div>;
}

export function StageControls({ path, hostId, seats, requests, capacity, spotlight, revision, pending, battle, onCommand }: {
  path: string; hostId: string; seats: StageSeat[]; capacity: number; spotlight: string | null; revision: number; pending: boolean; battle: boolean;
  requests: Person[];
  onCommand: (command: StageCommand) => Promise<boolean>;
}) {
  const audience = useData<Person[]>(battle ? null : path + '/stage/audience', revision);
  const [filter, setFilter] = useState('');
  const full = seats.length >= capacity;
  const people = audience?.data?.filter(person => (person.display_name + ' @' + person.handle).toLowerCase().includes(filter.trim().toLowerCase()));
  if (battle) return <p className="hint">Finish the challenge to invite stage guests or change the layout.</p>;
  return <div className="stage-controls">
    <div className="stage-layout-picker" role="group" aria-label="Stage layout">
      {([2,4,6,8] as const).map(cards=><button className="secondary" key={cards} disabled={pending||seats.length>=cards}
        aria-pressed={cards===capacity+1} onClick={()=>void onCommand({action:'layout',cards})}>{cards} cards</button>)}
    </div>
    <div className="stage-controls-heading">
      <strong>Guest seats · {seats.length}/{capacity}</strong>
      <div className="arena-buttons">
        {spotlight && <button className="secondary" disabled={pending} onClick={() => void onCommand({ action: 'spotlight', userId: null })}>
          <LayoutGrid size={15} /> Grid
        </button>}
        {spotlight !== hostId && <button className="secondary" disabled={pending}
          onClick={() => void onCommand({ action: 'spotlight', userId: hostId })}>Spotlight host</button>}
      </div>
    </div>
    {requests.length > 0 && <ul className="stage-people" aria-label="Stage requests">
      {requests.map(person => <li key={person.id}>
        <div><strong>{person.display_name}</strong><small>@{person.handle} · Requested a seat</small></div>
        <div className="arena-buttons">
          <button className="secondary" disabled={pending || full} aria-label={'Approve ' + person.display_name}
            onClick={() => void onCommand({action:'approve-request',userId:person.id})}>Approve</button>
          <button className="secondary" disabled={pending} aria-label={'Decline ' + person.display_name}
            onClick={() => void onCommand({action:'decline-request',userId:person.id})}>Decline</button>
        </div>
      </li>)}
    </ul>}
    {seats.length > 0 && <ul className="stage-people" aria-label="Guest seats">
      {seats.map(seat => <li key={seat.id}>
        <div><strong>{seat.display_name}</strong><small>@{seat.handle} · {seat.on_stage ? 'On stage' : 'Invited'}</small></div>
        <div className="arena-buttons">
          {seat.on_stage && <button className="secondary" disabled={pending || spotlight === seat.user_id}
            onClick={() => void onCommand({ action: 'spotlight', userId: seat.user_id })} aria-label={'Spotlight ' + seat.display_name}>
            <Star size={15} /> {spotlight === seat.user_id ? 'Spotlighted' : 'Spotlight'}
          </button>}
          <button className="secondary" disabled={pending} aria-label={(seat.on_stage ? 'Remove ' : 'Cancel invite for ') + seat.display_name}
            onClick={() => void onCommand({ action: 'remove', seatId: seat.id })}>{seat.on_stage ? 'Remove' : 'Cancel'}</button>
        </div>
      </li>)}
    </ul>}
    <form onSubmit={async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const handle = String(new FormData(form).get('handle')).trim().replace(/^@/, '');
      if (await onCommand({ action: 'invite', handle })) form.reset();
    }}>
      <label>Invite by handle<input name="handle" placeholder="@handle" maxLength={25} required disabled={full || pending} /></label>
      <button className="secondary" disabled={full || pending}><UserPlus size={16} /> Send invite</button>
    </form>
    <label>Find a viewer<input value={filter} onChange={event => setFilter(event.currentTarget.value)} placeholder="Name or handle" maxLength={60} /></label>
    {people?.length ? <ul className="stage-people stage-audience" aria-label="Watching now">
      {people.map(person => <li key={person.id}>
        <div><strong>{person.display_name}</strong><small>@{person.handle}</small></div>
        <button className="secondary" disabled={full || pending} aria-label={'Invite ' + person.display_name}
          onClick={() => void onCommand({ action: 'invite', handle: person.handle })}><UserPlus size={15} /> Invite</button>
      </li>)}
    </ul> : <p className="hint">{audience?.error ?? (audience ? 'No matching viewers.' : 'Loading viewers…')}</p>}
    {full && <p className="hint">All guest seats are reserved.</p>}
  </div>;
}
