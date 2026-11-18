'use client';

import { Camera, CameraOff, Heart, Mic, MicOff, Send, Shield, Swords } from 'lucide-react';
import { Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { send, useData, type Person } from './client';
import LiveModeration from './live-controls';

export type Grant = { id: string; url: string; token: string; host: boolean; hostId: string };
export type ChatLine = { id: string; user_id: string; handle: string; body: string };
type Match = {
  id: string; guest_id: string; guest_name: string;
  status: 'invited' | 'ready' | 'running' | 'finished' | 'cancelled';
  starts_at: string | null; ends_at: string | null; expires_at: string;
  host_score: number; guest_score: number; winner_id: string | null; outcome: string | null;
  voted: 'host' | 'guest' | null;
};
type Snapshot = {
  room: { id: string; chat_open: boolean; pinned_id: string | null; ended: boolean };
  self: { role: 'host' | 'moderator' | 'viewer'; mutedUntil: string | null };
  match?: Match; messages: ChatLine[]; now: number;
};

export default function Broadcast({ grant, user, leave }: { grant: Grant; user: Person; leave: () => void }) {
  const hostVideo = useRef<HTMLDivElement>(null);
  const guestVideo = useRef<HTMLDivElement>(null);
  const audioBox = useRef<HTMLDivElement>(null);
  const chatList = useRef<HTMLDivElement>(null);
  const connection = useRef<Room | null>(null);
  const prepared = useRef<string | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [enableAudio, setEnableAudio] = useState(false);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [showMod, setShowMod] = useState(false);
  const [reporting, setReporting] = useState<{ id: string; label: string }>();
  const [camera, setCamera] = useState(true);
  const [mic, setMic] = useState(true);
  const [clock, setClock] = useState(0);
  const [liveNotice, setLiveNotice] = useState('');
  const path = '/live/' + grant.id;
  const snapshot = useData<Snapshot>(everConnected ? path + '/state' : null, revision);
  const state = snapshot?.data;
  const match = state?.match;
  const activeGuest = match && ['ready', 'running'].includes(match.status) ? match.guest_id : null;
  const split = !!activeGuest;
  const readyMatch = match?.status === 'ready' && activeGuest === user.id ? match.id : null;
  const isPublisher = grant.host || activeGuest === user.id;
  const canModerate = state?.self.role === 'host' || state?.self.role === 'moderator';
  const chatAllowed = canModerate || (state?.room.chat_open && (!state.self.mutedUntil || new Date(state.self.mutedUntil).getTime() <= clock));
  const sync = () => setRevision(value => value + 1);

  useEffect(() => {
    if (!connected) return;
    const ticker = setInterval(() => setRevision(value => value + 1), 3500);
    return () => clearInterval(ticker);
  }, [connected]);

  useEffect(() => {
    if (!state) return;
    const received = Date.now();
    const update = () => setClock(state.now + Date.now() - received);
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => {
    const host = hostVideo.current;
    const guest = guestVideo.current;
    const audio = audioBox.current;
    if (!host || !guest || !audio) return;
    const room = new Room({ adaptiveStream: true, dynacast: true, videoCaptureDefaults: { resolution: VideoPresets.h540.resolution } });
    connection.current = room;
    let open = true;
    let requested = false;
    function refresh() {
      if (requested) return;
      requested = true;
      setTimeout(() => {
        requested = false;
        if (open) setRevision(value => value + 1);
      }, 180);
    }
    const container = (identity: string) => identity === grant.hostId ? host! : guest!;
    room.on(RoomEvent.LocalTrackPublished, (publication, person) => {
      if (publication.source !== Track.Source.Camera || !publication.track) return;
      const element = publication.track.attach();
      element.muted = true;
      container(person.identity).append(element);
    });
    room.on(RoomEvent.LocalTrackUnpublished, publication => publication.track?.detach().forEach(element => element.remove()));
    room.on(RoomEvent.TrackSubscribed, (track, _publication, person) => {
      const element = track.attach();
      if (element instanceof HTMLVideoElement) {
        element.playsInline = true;
        container(person.identity).append(element);
      } else audio.append(element);
    });
    room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => element.remove()));
    room.on(RoomEvent.ParticipantDisconnected, refresh);
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => setEnableAudio(!room.canPlaybackAudio));
    room.on(RoomEvent.Reconnecting, () => { setConnected(false); setStatus('Reconnecting…'); });
    room.on(RoomEvent.Reconnected, () => { setConnected(true); setStatus('Live'); refresh(); });
    room.on(RoomEvent.Disconnected, () => {
      if (!open) return;
      setConnected(false);
      setStatus('Disconnected');
      refresh();
    });
    room.on(RoomEvent.DataReceived, (_data, participant, _kind, topic) => {
      if (!participant && topic === 'mwitu-room') refresh();
    });

    void (async () => {
      try {
        await room.connect(grant.url, grant.token);
        if (!open) return;
        if (grant.host) {
          await room.localParticipant.enableCameraAndMicrophone();
          if (!open) { await room.disconnect(); return; }
          await send(path + '/online', 'POST');
        }
        if (!open) return;
        setStatus('Live');
        setConnected(true);
        setEverConnected(true);
        setEnableAudio(!room.canPlaybackAudio);
      } catch (error) {
        if (open) setError(grant.host ? 'Could not start the broadcast. Check camera, microphone and connection permissions.' : (error as Error).message);
        await room.disconnect();
        if (open && grant.host) await send(path + '/end', 'POST').catch(() => undefined);
      }
    })();
    return () => {
      open = false;
      connection.current = null;
      room.removeAllListeners();
      void room.disconnect();
      host.replaceChildren();
      guest.replaceChildren();
      audio.replaceChildren();
    };
  }, [grant, path]);

  useEffect(() => {
    if (!connected || !activeGuest || activeGuest !== user.id || !match?.id || prepared.current === match.id) return;
    const room = connection.current;
    if (!room) return;
    const matchId = match.id;
    let valid = true;
    async function prepare() {
      try {
        await send(path + '/match', 'POST', { action: 'restore', matchId });
        if (!valid) return;
        await room!.localParticipant.enableCameraAndMicrophone();
        if (!valid) return;
        prepared.current = matchId;
        setCamera(true);
        setMic(true);
        if (readyMatch) await send(path + '/match', 'POST', { action: 'ready', matchId });
        if (valid) setRevision(value => value + 1);
      } catch (error) {
        if (!valid) return;
        setError('Could not start the challenger camera. ' + (error as Error).message);
        if (readyMatch) await send(path + '/match', 'POST', { action: 'decline', matchId }).catch(() => undefined);
        if (valid) setRevision(value => value + 1);
      }
    }
    void prepare();
    return () => { valid = false; };
  }, [activeGuest, connected, match?.id, path, readyMatch, user.id]);

  useEffect(() => {
    if (grant.host || isPublisher) return;
    const participant = connection.current?.localParticipant;
    if (participant?.isCameraEnabled) void participant.setCameraEnabled(false).catch(() => undefined);
    if (participant?.isMicrophoneEnabled) void participant.setMicrophoneEnabled(false).catch(() => undefined);
  }, [grant.host, isPublisher]);

  useEffect(() => {
    const node = chatList.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [state?.messages.at(-1)?.id]);

  async function perform(operation: () => Promise<unknown>, notice = '') {
    if (pending) return;
    setPending(true);
    setError('');
    setLiveNotice('');
    try { await operation(); setLiveNotice(notice); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); sync(); }
  }

  function matchAction(action: string, data: object = {}) {
    return perform(() => send(path + '/match', 'POST', { action, matchId: match?.id, ...data }));
  }

  function submit(event: FormEvent<HTMLFormElement>, endpoint: string, payload: object, notice?: string) {
    event.preventDefault();
    const form = event.currentTarget;
    void perform(async () => { await send(path + endpoint, 'POST', payload); form.reset(); }, notice);
  }

  function exit() {
    void perform(async () => {
      if (grant.host) await send(path + '/end', 'POST');
      else if (activeGuest === user.id && match?.status === 'running' && connected) {
        await send(path + '/match', 'POST', { action: 'forfeit', matchId: match.id });
      }
      leave();
    });
  }

  function toggleDevice(kind: 'camera' | 'mic') {
    void perform(async () => {
      const local = connection.current?.localParticipant;
      if (!local) return;
      if (kind === 'camera') { await local.setCameraEnabled(!camera); setCamera(!camera); }
      else { await local.setMicrophoneEnabled(!mic); setMic(!mic); }
    });
  }

  const starting = match?.status === 'running' && !!match.starts_at && new Date(match.starts_at).getTime() > clock;
  const seconds = match?.status === 'running'
    ? Math.max(0, Math.ceil((new Date((starting ? match.starts_at : match.ends_at)!).getTime() - clock) / 1000)) : 0;
  const countdown = starting ? 'Starts in ' + seconds : Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const canVote = connected && !grant.host && match?.guest_id !== user.id && !match?.voted && !starting && seconds > 0;
  const pinned = state?.messages.find(message => message.id === state.room.pinned_id);

  return <div className="arena">
    <div className="live-status">
      <span role="status">{state?.room.ended ? 'Broadcast ended.' : status}</span>
      <div className="arena-buttons">
        {canModerate && <button className="secondary" onClick={() => setShowMod(value => !value)} aria-expanded={showMod}><Shield size={16} /> Moderation</button>}
        <button className="secondary" disabled={pending} onClick={exit}>{grant.host ? 'End broadcast' : 'Leave'}</button>
      </div>
    </div>
    <div className={'arena-media' + (split ? ' split' : '')}>
      <div className="arena-tile"><div ref={hostVideo} /><span>Host</span></div>
      <div className="arena-tile" hidden={!split}><div ref={guestVideo} /><span>{match?.guest_name}</span></div>
    </div>
    <div ref={audioBox} />
    <div className="arena-buttons">
      {enableAudio && <button className="link" onClick={() => void connection.current?.startAudio().catch(() => setError('Could not enable audio.'))}>Enable sound</button>}
      {connected && isPublisher && <>
        <button className="icon" aria-label={camera ? 'Turn camera off' : 'Turn camera on'} disabled={pending} onClick={() => toggleDevice('camera')}>{camera ? <Camera size={19} /> : <CameraOff size={19} />}</button>
        <button className="icon" aria-label={mic ? 'Mute microphone' : 'Unmute microphone'} disabled={pending} onClick={() => toggleDevice('mic')}>{mic ? <Mic size={19} /> : <MicOff size={19} />}</button>
      </>}
    </div>
    {match?.status === 'running' && <section className="battle" aria-label="1v1 scoreboard">
      <div className="battle-head"><span><Swords size={17} /> 1v1 LIVE</span><strong>{countdown}</strong></div>
      <div className="battle-score">
        <div><small>Host</small><strong>{match.host_score}</strong></div>
        <div><small>{match.guest_name}</small><strong>{match.guest_score}</strong></div>
      </div>
      <div className="arena-buttons">
        {canVote && <>
          <button className="secondary" disabled={pending} onClick={() => void matchAction('vote', { side: 'host' })}><Heart size={16} /> Vote host</button>
          <button className="secondary" disabled={pending} onClick={() => void matchAction('vote', { side: 'guest' })}><Heart size={16} /> Vote challenger</button>
        </>}
        {match.voted && <small>You voted for the {match.voted === 'host' ? 'host' : 'challenger'}.</small>}
        {isPublisher && <button className="link" disabled={pending} onClick={() => {
          if (window.confirm('Forfeit this match?')) void matchAction('forfeit');
        }}>Forfeit match</button>}
      </div>
    </section>}
    {match?.status === 'finished' && <section className="battle" aria-label="Match result">
      <div className="battle-head"><span><Swords size={17} /> {match.winner_id === null ? 'Draw' : (match.winner_id === grant.hostId ? 'Host wins' : match.guest_name + ' wins')}</span>
        <strong>{match.host_score} – {match.guest_score}</strong></div>
      {match.outcome !== 'time' && <small>Match ended early.</small>}
    </section>}
    {match && ['invited','ready'].includes(match.status) &&
      <div className="battle">
        <p>{match.status === 'ready' ? 'Waiting for the challenger to publish video…' :
          match.guest_id === user.id ? 'The host invited you to a 1v1 LIVE battle.' : 'Challenge sent to ' + match.guest_name + '.'}</p>
        <div className="arena-buttons">
          {connected && match.guest_id === user.id && match.status === 'invited' && <>
            <button className="primary" disabled={pending} onClick={() => void matchAction('accept')}>Accept challenge</button>
            <button className="secondary" disabled={pending} onClick={() => void matchAction('decline')}>Decline</button>
          </>}
          {grant.host && connected && <button className="secondary" disabled={pending} onClick={() => void matchAction('cancel')}>Cancel challenge</button>}
        </div>
      </div>}
    {match?.status === 'cancelled' && <p className="hint">Challenge {match.outcome === 'guest_removed' ? 'ended' : match.outcome}.</p>}
    {grant.host && connected && (!match || ['finished','cancelled'].includes(match.status)) &&
      <form className="inline" onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const handle = String(new FormData(form).get('handle')).trim().replace(/^@/, '');
        void matchAction('invite', { handle });
      }}>
        <input name="handle" aria-label="Challenger handle" required maxLength={25} placeholder="@handle watching your LIVE" />
        <button className="primary" disabled={pending}><Swords size={17} /> Invite to 1v1</button>
      </form>}
    {pinned && <p className="pinned"><strong>Pinned · @{pinned.handle}</strong> {pinned.body}</p>}
    <div className="list live-chat" ref={chatList} aria-live="polite">
      {state?.messages.filter(message => message.id !== pinned?.id).map(message =>
        <div key={message.id} className="live-message"><p><strong>@{message.handle}</strong> {message.body}</p>
          {connected && message.user_id !== user.id && <button className="link" onClick={() => setReporting({ id: message.user_id, label: '@' + message.handle })}>Report</button>}
        </div>)}
    </div>
    {connected && chatAllowed ? <form className="inline" onSubmit={event => submit(event, '/chat', { body: new FormData(event.currentTarget).get('body') })}>
      <input name="body" aria-label="Live chat message" placeholder="Chat with the room…" maxLength={300} required />
      <button className="primary" disabled={pending} aria-label="Send chat message"><Send size={17} /></button>
    </form> : connected && state && <p className="hint">{state.room.chat_open ? 'Your chat is timed out.' : 'Chat is closed.'}</p>}
    {connected && !grant.host && <button className="link" onClick={() => setReporting({ id: grant.hostId, label: 'host' })}>Report broadcast</button>}
    {reporting && <form className="inline" onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const reason = new FormData(form).get('reason');
      void perform(async () => { await send(path + '/report', 'POST', { userId: reporting.id, reason }); setReporting(undefined); }, 'Report submitted.');
    }}>
      <input name="reason" aria-label={'Reason for reporting ' + reporting.label} required maxLength={300} placeholder={'Report ' + reporting.label} />
      <button className="primary" disabled={pending}>Submit report</button>
      <button type="button" className="secondary" onClick={() => setReporting(undefined)}>Cancel</button>
    </form>}
    {showMod && canModerate && state && <LiveModeration path={path} user={user} hostId={grant.hostId} chatOpen={state.room.chat_open}
      messages={state.messages} pinnedId={state.room.pinned_id} revision={revision} ended={state.room.ended} onChange={sync} />}
    {liveNotice && <p role="status">{liveNotice}</p>}
    {(error || snapshot?.error) && <p className="error" role="alert">{error || snapshot?.error}</p>}
  </div>;
}
