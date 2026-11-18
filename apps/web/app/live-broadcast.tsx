'use client';

import { Camera, CameraOff, Flag, Heart, Maximize, MessageCircle, Mic, MicOff, Minimize, Send, Share2, Shield, Sparkles, Swords, X } from 'lucide-react';
import { LocalVideoTrack, Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { send, useData, type Person } from './client';
import LiveModeration from './live-controls';
import { CameraEffects, cameraLooks, type CameraLook } from './live-effects';

const drawerTitles = { share: 'Share LIVE', moderation: 'Moderation', effects: 'Camera effects' };

export type Grant = { id: string; url: string; token: string; host: boolean; guest?: boolean; hostId: string; shareCode: string };
export type ChatLine = { id: string; user_id: string; handle: string; body: string };
type Match = {
  id: string; guest_id: string; guest_name: string;
  status: 'invited' | 'ready' | 'running' | 'finished' | 'cancelled';
  starts_at: string | null; ends_at: string | null; expires_at: string;
  host_score: number; guest_score: number; winner_id: string | null; outcome: string | null;
  voted: 'host' | 'guest' | null;
};
type Snapshot = {
  room: { id: string; chat_open: boolean; pinned_id: string | null; ended: boolean; guest_access: boolean };
  self: { role: 'host' | 'moderator' | 'viewer' | 'guest'; mutedUntil: string | null };
  match?: Match; messages: ChatLine[]; now: number;
};

export default function Broadcast({ grant, user, signIn, leave }: {
  grant: Grant; user: Person | null; signIn: () => void; leave: () => void;
}) {
  const hostVideo = useRef<HTMLDivElement>(null);
  const guestVideo = useRef<HTMLDivElement>(null);
  const audioBox = useRef<HTMLDivElement>(null);
  const chatList = useRef<HTMLDivElement>(null);
  const followChat = useRef(true);
  const connection = useRef<Room | null>(null);
  const prepared = useRef<string | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [enableAudio, setEnableAudio] = useState(false);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [drawer, setDrawer] = useState<keyof typeof drawerTitles | null>(null);
  const [fit, setFit] = useState(true);
  const [hideChat, setHideChat] = useState(false);
  const [localVideo, setLocalVideo] = useState<LocalVideoTrack | null>(null);
  const [look, setLook] = useState<CameraLook>(cameraLooks[0]);
  const [strength, setStrength] = useState(55);
  const [effectPending, setEffectPending] = useState(false);
  const [effectError, setEffectError] = useState('');
  const [shareNotice, setShareNotice] = useState('');
  const [reporting, setReporting] = useState<{ id: string; label: string }>();
  const [camera, setCamera] = useState(true);
  const [mic, setMic] = useState(true);
  const [clock, setClock] = useState(0);
  const [liveNotice, setLiveNotice] = useState('');
  const path = '/live/' + grant.id;
  const statePath = grant.guest ? '/live/handoff/' + grant.shareCode + '/state' : path + '/state';
  const snapshot = useData<Snapshot>(everConnected ? statePath : null, revision);
  const state = snapshot?.data;
  const match = state?.match;
  const activeGuest = match && ['ready', 'running'].includes(match.status) ? match.guest_id : null;
  const split = !!activeGuest;
  const readyMatch = match?.status === 'ready' && activeGuest === user?.id ? match.id : null;
  const isPublisher = grant.host || activeGuest === user?.id;
  const canModerate = state?.self.role === 'host' || state?.self.role === 'moderator';
  const chatAllowed = canModerate || (state?.room.chat_open && (!state.self.mutedUntil || new Date(state.self.mutedUntil).getTime() <= clock));
  const sync = () => setRevision(value => value + 1);
  const shareUrl = () => new URL('/?live=' + grant.shareCode, window.location.origin).href;
  const toggleDrawer = (panel: keyof typeof drawerTitles) => setDrawer(current => current === panel ? null : panel);

  async function applyLook(next: CameraLook) {
    const track = localVideo;
    if (!track || effectPending) return;
    setEffectPending(true);
    setEffectError('');
    const current = track.getProcessor();
    let created: CameraEffects | undefined;
    try {
      if (next.id === 'off') {
        if (current instanceof CameraEffects) await track.stopProcessor(false);
      } else if (current instanceof CameraEffects) {
        current.setLook(next, strength);
      } else {
        created = new CameraEffects(next, strength, () => {
          if (track.getProcessor() !== created) return;
          void track.stopProcessor(false).then(() => {
            setLook(cameraLooks[0]);
            setEffectError('The camera effect stopped. Viewers are seeing Original.');
          }).catch(() => setEffectError('The camera effect stopped. Turn your camera off and back on to retry.'));
        });
        await track.setProcessor(created, true);
      }
      setLook(next);
    } catch {
      if (created && track.getProcessor() === created) await track.stopProcessor(false).catch(() => undefined);
      else await created?.destroy();
      setEffectError('Could not switch camera effects on this device.');
    } finally { setEffectPending(false); }
  }

  async function shareRoom(action: 'link' | 'code' | 'share') {
    setShareNotice('');
    try {
      if (action === 'share') {
        await navigator.share({ title: 'Join this LIVE on Tiktok mwitu', text: 'LIVE code: ' + grant.shareCode, url: shareUrl() });
      } else {
        await navigator.clipboard.writeText(action === 'code' ? grant.shareCode : shareUrl());
        setShareNotice(action === 'code' ? 'LIVE code copied.' : 'Share link copied.');
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setShareNotice('Select and copy the link or code above.');
    }
  }

  useEffect(() => {
    if (!connected) return;
    const ticker = setInterval(() => setRevision(value => value + 1), grant.guest ? 8000 : 3500);
    return () => clearInterval(ticker);
  }, [connected, grant.guest]);

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
    const portraitPhone = window.matchMedia('(pointer: coarse) and (orientation: portrait)').matches;
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        facingMode: 'user',
        frameRate: { ideal: 24, max: 30 },
        resolution: portraitPhone ? { width: 540, height: 960, aspectRatio: 9 / 16 } : VideoPresets.h540.resolution,
      },
    });
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
      if (element instanceof HTMLVideoElement) {
        element.playsInline = true;
        const facing = publication.track.mediaStreamTrack.getSettings().facingMode;
        if (!facing || facing === 'user') element.classList.add('self-preview');
      }
      container(person.identity).append(element);
      if (publication.track instanceof LocalVideoTrack) setLocalVideo(publication.track);
    });
    room.on(RoomEvent.LocalTrackUnpublished, publication => {
      publication.track?.detach().forEach(element => element.remove());
      if (publication.source === Track.Source.Camera) setLocalVideo(null);
    });
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
      host.replaceChildren();
      guest.replaceChildren();
      audio.replaceChildren();
      setLocalVideo(null);
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
    if (grant.guest && state?.room.guest_access === false) void connection.current?.disconnect();
  }, [grant.guest, state?.room.guest_access]);

  useEffect(() => {
    if (!connected || !activeGuest || activeGuest !== user?.id || !match?.id || prepared.current === match.id) return;
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
  }, [activeGuest, connected, match?.id, path, readyMatch, user?.id]);

  useEffect(() => {
    if (grant.host || isPublisher) return;
    const participant = connection.current?.localParticipant;
    if (participant?.isCameraEnabled) void participant.setCameraEnabled(false).catch(() => undefined);
    if (participant?.isMicrophoneEnabled) void participant.setMicrophoneEnabled(false).catch(() => undefined);
  }, [grant.host, isPublisher]);

  useEffect(() => {
    const node = chatList.current;
    if (node && followChat.current) node.scrollTop = node.scrollHeight;
  }, [state?.messages.at(-1)?.id, hideChat, state?.room.pinned_id]);

  useEffect(() => {
    setLook(cameraLooks[0]);
    setEffectError('');
  }, [localVideo]);

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
      else if (activeGuest === user?.id && match?.status === 'running' && connected) {
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
  const canVote = connected && !!user && !grant.host && match?.guest_id !== user.id && !match?.voted && !starting && seconds > 0;
  const pinned = state?.messages.find(message => message.id === state.room.pinned_id);

  return <div className="arena">
    <div className={'arena-media' + (split ? ' split' : '') + (fit ? ' fit' : '')}>
      <div className="arena-tile"><div ref={hostVideo} />{split && <span>Host</span>}</div>
      <div className="arena-tile" hidden={!split}><div ref={guestVideo} /><span>{match?.guest_name}</span></div>
    </div>
    <div ref={audioBox} hidden />
    <div className="arena-top">
      <span className={'arena-status' + (connected && !state?.room.ended ? ' on-air' : '')} role="status">
        {state?.room.ended ? 'Broadcast ended.' : grant.guest && state?.room.guest_access === false ? 'Guest watching is off.' : connected ? 'LIVE' : status}
      </span>
      <div className="arena-buttons">
        <button className="arena-action" aria-label={fit ? 'Fill screen' : 'Fit entire video'} title={fit ? 'Fill screen' : 'Fit entire video'} aria-pressed={fit} onClick={() => setFit(value => !value)}>{fit ? <Maximize size={18} /> : <Minimize size={18} />}</button>
        {connected && grant.shareCode && <button className="arena-action" aria-label="Share LIVE" title="Share LIVE" onClick={() => toggleDrawer('share')} aria-expanded={drawer === 'share'}><Share2 size={18} /></button>}
        {canModerate && <button className="arena-action" aria-label="Moderation" title="Moderation" onClick={() => toggleDrawer('moderation')} aria-expanded={drawer === 'moderation'}><Shield size={18} /></button>}
        <button className="arena-action" aria-label={grant.host ? 'End broadcast' : 'Leave'} title={grant.host ? 'End broadcast' : 'Leave'} disabled={pending} onClick={exit}><X size={21} /></button>
      </div>
    </div>
    <div className="arena-match">
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
      {match && ['invited','ready'].includes(match.status) && (match.status === 'ready' || grant.host || match.guest_id === user?.id) &&
        <div className="battle">
          <p>{match.status === 'ready' ? 'Waiting for the challenger to publish video…' :
            match.guest_id === user?.id ? 'The host invited you to a 1v1 LIVE battle.' : 'Seat reserved for ' + match.guest_name + '. Share the LIVE link or code so they can join.'}</p>
          <div className="arena-buttons">
            {connected && match.guest_id === user?.id && match.status === 'invited' && <>
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
          <input name="handle" aria-label="Challenger handle" required maxLength={25} placeholder="Challenger’s @handle on Tiktok mwitu" />
          <button className="primary" disabled={pending}><Swords size={17} /> Invite to 1v1</button>
        </form>}
    </div>
    <div className="arena-foot">
      {!hideChat && <div className="arena-conversation">
        {pinned && <p className="pinned"><strong>Pinned · @{pinned.handle}</strong> {pinned.body}</p>}
        <div className="live-chat" ref={chatList} role="log" aria-label="LIVE chat" onScroll={event => {
          const node = event.currentTarget;
          followChat.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}>
          {state?.messages.filter(message => message.id !== pinned?.id).map(message =>
            <div key={message.id} className="live-message"><p><strong>@{message.handle}</strong> {message.body}</p>
              {connected && user && message.user_id !== user.id && <button className="link" onClick={() => setReporting({ id: message.user_id, label: '@' + message.handle })}>Report</button>}
            </div>)}
        </div>
        {connected && user && chatAllowed ? <form className="inline" onSubmit={event => submit(event, '/chat', { body: new FormData(event.currentTarget).get('body') })}>
          <input name="body" aria-label="Live chat message" placeholder="Chat with the room…" maxLength={300} required />
          <button className="primary" disabled={pending} aria-label="Send chat message"><Send size={17} /></button>
        </form> : connected && user && state && <p className="hint">{state.room.chat_open ? 'Your chat is timed out.' : 'Chat is closed.'}</p>}
        {grant.guest && !state?.room.ended && <div className="arena-buttons">
          {connected && <span className="hint">Watching as a guest</span>}
          <button className="link" onClick={signIn}>Sign in to chat or vote</button>
        </div>}
      </div>}
      <div className="arena-buttons arena-tools">
        <button className="arena-action" aria-label={hideChat ? 'Show chat' : 'Hide chat'} title={hideChat ? 'Show chat' : 'Hide chat'} aria-pressed={!hideChat} onClick={() => {
          followChat.current = true;
          setHideChat(value => !value);
        }}><MessageCircle size={19} /></button>
        {enableAudio && <button className="arena-action arena-pill" onClick={() => void connection.current?.startAudio().catch(() => setError('Could not enable audio.'))}>Enable sound</button>}
        {connected && isPublisher && <>
          <button className="arena-action" aria-label={camera ? 'Turn camera off' : 'Turn camera on'} title={camera ? 'Turn camera off' : 'Turn camera on'} disabled={pending || effectPending} onClick={() => toggleDevice('camera')}>{camera ? <Camera size={19} /> : <CameraOff size={19} />}</button>
          <button className="arena-action" aria-label={mic ? 'Mute microphone' : 'Unmute microphone'} title={mic ? 'Mute microphone' : 'Unmute microphone'} disabled={pending} onClick={() => toggleDevice('mic')}>{mic ? <Mic size={19} /> : <MicOff size={19} />}</button>
          <button className="arena-action arena-pill" aria-label="Camera effects" aria-expanded={drawer === 'effects'} onClick={() => toggleDrawer('effects')}><Sparkles size={18} /> Effects</button>
        </>}
        {connected && user && !grant.host && <button className="arena-action" aria-label="Report broadcast" title="Report broadcast" onClick={() => setReporting({ id: grant.hostId, label: 'host' })}><Flag size={17} /></button>}
      </div>
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
      {liveNotice && <p className="arena-notice" role="status">{liveNotice}</p>}
      {(error || snapshot?.error) && <p className="arena-notice error" role="alert">{error || snapshot?.error}</p>}
    </div>
    {drawer && <section className="arena-drawer" aria-label={drawerTitles[drawer]}>
      <div className="arena-drawer-heading">
        <h3>{drawerTitles[drawer]}</h3>
        <button className="arena-action" onClick={() => setDrawer(null)} aria-label={'Close ' + drawerTitles[drawer]}><X size={19} /></button>
      </div>
      {drawer === 'share' && connected && grant.shareCode && <div className="arena-share">
        <label>LIVE code<input readOnly value={grant.shareCode} onFocus={event => event.target.select()} /></label>
        <label>Share link<input readOnly value={shareUrl()} onFocus={event => event.target.select()} /></label>
        <div className="arena-buttons">
          <button className="secondary" onClick={() => void shareRoom('link')}>Copy link</button>
          <button className="secondary" onClick={() => void shareRoom('code')}>Copy code</button>
          {typeof navigator.share === 'function' && <button className="primary" onClick={() => void shareRoom('share')}>Share link</button>}
        </div>
        {shareNotice && <p role="status">{shareNotice}</p>}
      </div>}
      {drawer === 'moderation' && canModerate && state && user && <LiveModeration path={path} user={user} hostId={grant.hostId} chatOpen={state.room.chat_open}
        guestAccess={state.room.guest_access} messages={state.messages} pinnedId={state.room.pinned_id} revision={revision} ended={state.room.ended} onChange={sync} />}
      {drawer === 'effects' && isPublisher && <>
        <p className="hint">{camera && localVideo ? 'Changes your camera for everyone watching.' : 'Turn on your camera to use effects.'}</p>
        <div className="arena-looks" aria-label="Camera presets">
          {cameraLooks.map((preset, index) => <button className="arena-look" key={preset.id} type="button" aria-pressed={look.id === preset.id}
            title={preset.description}
            disabled={!localVideo || !camera || pending || effectPending || !connected} onClick={() => void applyLook(preset)}>
            <span aria-hidden="true" style={{ backgroundPosition: (index * 25) + '% center' }} />
            <strong>{preset.name}</strong>
          </button>)}
        </div>
        {look.id !== 'off' && <div className="arena-strength">
          <div><label htmlFor="camera-effect-intensity">Intensity</label><output htmlFor="camera-effect-intensity">{strength}%</output></div>
          <input id="camera-effect-intensity" type="range" min={0} max={100} value={strength} disabled={effectPending || !camera} onChange={event => {
            const value = event.currentTarget.valueAsNumber;
            const processor = localVideo?.getProcessor();
            if (processor instanceof CameraEffects) processor.setLook(look, value);
            setStrength(value);
          }} />
        </div>}
        {effectError && <p className="error" role="alert">{effectError}</p>}
      </>}
    </section>}
  </div>;
}
