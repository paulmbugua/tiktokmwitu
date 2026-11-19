'use client';

import { Camera, CameraOff, Expand, Flag, Gift, Heart, LayoutGrid, LogOut, Maximize, MessageCircle, Mic, MicOff, Minimize, Send, Share2, Shield, Sparkles, Swords, UsersRound, X } from 'lucide-react';
import { LocalVideoTrack, Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { send, useData, type Person } from './client';
import LiveModeration from './live-controls';
import { CameraEffects, cameraLooks, type CameraLook } from './live-effects';
import { StageControls, StageTile, type StageCommand, type StageState } from './live-stage';
import LiveGifts, { GiftEffects, type GiftEvent } from './live-gifts';
import LiveInvitePlans from './live-invite-plans';
import Promote from './promote';
import ChallengeSetup from './live-challenge';
import LiveChatLog, { type ChatLine } from './live-chat-log';

export type { ChatLine } from './live-chat-log';

const drawerTitles = { share: 'Share LIVE', moderation: 'Moderation', effects: 'Camera effects', stage: 'Guest stage', gifts: 'LIVE gifts', promote: 'Promote', challenge:'LIVE challenge' };

export type Grant = { id: string; url: string; token: string; host: boolean; guest?: boolean; hostId: string; shareCode?: string };
type Match = {
  id: string; guest_id: string; guest_name: string;
  status: 'invited' | 'ready' | 'running' | 'finished' | 'cancelled';
  starts_at: string | null; ends_at: string | null; expires_at: string;
  host_score: number; guest_score: number; winner_id: string | null; outcome: string | null;
  voted: 'host' | 'guest' | null;
  voted_for?:string|null;
  guests?:{user_id:string;display_name:string;status:'invited'|'accepted'|'ready';score:number}[];
};
type Snapshot = {
  hostProfile?:{handle:string;following:boolean};
  room: { id: string; chat_open: boolean; pinned_id: string | null; ended: boolean; guest_access: boolean };
  self: { role: 'host' | 'moderator' | 'viewer' | 'guest'; mutedUntil: string | null };
  match?: Match; stage?: StageState; messages: ChatLine[]; gifts?: GiftEvent[]; now: number;
};

async function releaseGuestMedia(room: Room) {
  const participant = room.localParticipant;
  const tracks = [participant.getTrackPublication(Track.Source.Camera)?.track, participant.getTrackPublication(Track.Source.Microphone)?.track]
    .flatMap(track => track ? [track] : []);
  await participant.unpublishTracks(tracks);
}

export default function Broadcast({ grant, user, signIn, leave }: {
  grant: Grant; user: Person | null; signIn: () => void; leave: () => void;
}) {
  const audioBox = useRef<HTMLDivElement>(null);
  const arena = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const connection = useRef<Room | null>(null);
  const prepared = useRef<string | null>(null);
  const preparedSeat = useRef<string | null>(null);
  const stageSeatRef = useRef<string | null>(null);
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
  const [videos, setVideos] = useState<Record<string, { track: Track; name: string }>>({});
  const [cameraRetry, setCameraRetry] = useState(0);
  const [stageMediaError, setStageMediaError] = useState('');
  const [look, setLook] = useState<CameraLook>(cameraLooks[0]);
  const [strength, setStrength] = useState(55);
  const [effectPending, setEffectPending] = useState(false);
  const [effectError, setEffectError] = useState('');
  const [reporting, setReporting] = useState<{ id: string; label: string }>();
  const [camera, setCamera] = useState(true);
  const [mic, setMic] = useState(true);
  const [clock, setClock] = useState(0);
  const [liveNotice, setLiveNotice] = useState('');
  const lastSnapshot = useRef<Snapshot | undefined>(undefined);
  const path = '/live/' + grant.id;
  const statePath = grant.guest ? '/live/handoff/' + grant.shareCode + '/state' : path + '/state';
  const snapshot = useData<Snapshot>(everConnected ? statePath : null, revision);
  const state = snapshot?.data ?? lastSnapshot.current;
  if (snapshot?.data) lastSnapshot.current = snapshot.data;
  const match = state?.match;
  const roster=match?.guests??[];
  const four=roster.length===3;
  const ownBattle=roster.find(person=>person.user_id===user?.id);
  const invited=!!user&&(four?ownBattle?.status==='invited'&&!!match&&['invited','ready'].includes(match.status):
    match?.status==='invited'&&match.guest_id===user.id);
  const battle = !!match && ['invited', 'ready', 'running'].includes(match.status);
  const split = !!match&&['ready','running'].includes(match.status);
  const battlePublisher=split&&!!user&&(four?!!ownBattle&&ownBattle.status!=='invited':match?.guest_id===user.id);
  const readyMatch = match?.status==='ready'&&battlePublisher&&(!four||ownBattle?.status==='accepted')?match.id:null;
  const seats = state?.stage?.seats ?? [];
  const mySeat = seats.find(seat => seat.user_id === user?.id);
  const stageSeatId = mySeat?.on_stage ? mySeat.id : null;
  stageSeatRef.current = stageSeatId;
  const isPublisher = grant.host || battlePublisher || !!stageSeatId;
  const mediaEligible=useRef(false);
  mediaEligible.current=battlePublisher;
  const stageGuests = seats.filter(seat => seat.on_stage);
  const spotlight = stageGuests.length > 0 && !split ? state?.stage?.spotlight ?? null : null;
  const fullscreen = !!spotlight && state?.stage?.fullscreen === true;
  const docked = !fullscreen && (split || stageGuests.length > 0);
  const canModerate = state?.self.role === 'host' || state?.self.role === 'moderator';
  const chatAllowed = canModerate || (state?.room.chat_open && (!state.self.mutedUntil || new Date(state.self.mutedUntil).getTime() <= clock));
  const sync = () => setRevision(value => value + 1);
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
    const audio = audioBox.current;
    if (!audio) return;
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
    function addCamera(identity: string, name: string, track: Track) {
      setVideos(current => ({ ...current, [identity]: { track, name } }));
    }
    function removeCamera(track: Track) {
      setVideos(current => Object.fromEntries(Object.entries(current).filter(([, camera]) => camera.track !== track)));
    }
    room.on(RoomEvent.LocalTrackPublished, (publication, person) => {
      if (publication.source !== Track.Source.Camera || !publication.track) return;
      addCamera(person.identity, person.name ?? 'Host', publication.track);
      if (publication.track instanceof LocalVideoTrack) setLocalVideo(publication.track);
    });
    room.on(RoomEvent.LocalTrackUnpublished, publication => {
      if (publication.source !== Track.Source.Camera) return;
      if (publication.track) removeCamera(publication.track);
      setLocalVideo(null);
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, person) => {
      if (publication.source === Track.Source.Camera) addCamera(person.identity, person.name ?? 'Guest', track);
      else if (publication.source === Track.Source.Microphone) audio.append(track.attach());
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      if (publication.source === Track.Source.Camera) removeCamera(track);
      else track.detach().forEach(element => element.remove());
    });
    room.on(RoomEvent.ParticipantConnected, refresh);
    room.on(RoomEvent.ParticipantDisconnected, refresh);
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => setEnableAudio(!room.canPlaybackAudio));
    room.on(RoomEvent.Reconnecting, () => { setConnected(false); setStatus('Reconnecting…'); });
    room.on(RoomEvent.Reconnected, () => { setConnected(true); setStatus('Live'); refresh(); });
    room.on(RoomEvent.Disconnected, () => {
      if (!open) return;
      setVideos({});
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
      audio.replaceChildren();
    };
  }, [grant, path]);

  useEffect(() => {
    if (grant.guest && state?.room.guest_access === false) void connection.current?.disconnect();
  }, [grant.guest, state?.room.guest_access]);

  useEffect(() => {
    if (!connected || !battlePublisher || !match?.id || (prepared.current===match.id&&!readyMatch)) return;
    const room = connection.current;
    if (!room) return;
    const matchId = match.id;
    let valid = true;
    async function prepare() {
      try {
        if(prepared.current!==matchId){
          await send(path + '/match', 'POST', { action: 'restore', matchId });
          if (!valid) return;
          await room!.localParticipant.enableCameraAndMicrophone();
          if (!valid) {
            if(!mediaEligible.current)await releaseGuestMedia(room!);
            return;
          }
          prepared.current = matchId;
          setCamera(true);
          setMic(true);
        }
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
  }, [battlePublisher, connected, match?.id, path, readyMatch]);

  useEffect(()=>{
    const root=arena.current;
    const foot=footer.current;
    if(!root||!foot)return;
    const hud=root.querySelector('.arena-match');
    const update=()=>{
      root.style.setProperty('--stage-controls-height',Math.ceil(foot.getBoundingClientRect().height+10)+'px');
      root.style.setProperty('--stage-hud-height',Math.ceil(hud?.getBoundingClientRect().height??0)+'px');
    };
    const observer=new ResizeObserver(update);
    observer.observe(foot);
    if(hud)observer.observe(hud);
    update();
    return ()=>observer.disconnect();
  },[]);

  useEffect(() => {
    if (!stageSeatId) {
      preparedSeat.current = null;
      setStageMediaError('');
      return;
    }
    const room = connection.current;
    if (!connected || !room || preparedSeat.current === stageSeatId) return;
    let valid = true;
    setStageMediaError('');
    void (async () => {
      try {
        await send(path + '/stage', 'POST', { action: 'restore', seatId: stageSeatId });
        if (!valid) return;
        await room.localParticipant.enableCameraAndMicrophone();
        if (!valid) {
          if (stageSeatRef.current !== stageSeatId) await releaseGuestMedia(room);
          return;
        }
        preparedSeat.current = stageSeatId;
        setCamera(true);
        setMic(true);
      } catch {
        if (valid) setStageMediaError('Could not start camera and microphone. Check your browser permissions and try again.');
      }
    })();
    return () => { valid = false; };
  }, [connected, path, stageSeatId, cameraRetry]);

  useEffect(() => {
    if (grant.host || isPublisher) return;
    const room = connection.current;
    if (room) void releaseGuestMedia(room).catch(() => undefined);
  }, [grant.host, isPublisher]);

  useEffect(() => {
    setLook(cameraLooks[0]);
    setEffectError('');
  }, [localVideo]);

  async function perform(operation: () => Promise<unknown>, notice = '') {
    if (pending) return false;
    setPending(true);
    setError('');
    setLiveNotice('');
    try { await operation(); setLiveNotice(notice); return true; }
    catch (error) { setError((error as Error).message); return false; }
    finally { setPending(false); sync(); }
  }

  function matchAction(action: string, data: object = {}) {
    return perform(() => send(path + '/match', 'POST', { action, matchId: match?.id, ...data }));
  }

  function stageAction(command: StageCommand) {
    return perform(async () => {
      await send(path + '/stage', 'POST', command);
      const room = connection.current;
      if (command.action === 'leave' && room) await releaseGuestMedia(room).catch(() => undefined);
    }, command.action === 'invite' ? 'Stage invitation sent.' : '');
  }

  function submit(event: FormEvent<HTMLFormElement>, endpoint: string, payload: object, notice?: string) {
    event.preventDefault();
    const form = event.currentTarget;
    void perform(async () => { await send(path + endpoint, 'POST', payload); form.reset(); }, notice);
  }

  function exit() {
    void perform(async () => {
      if (grant.host) await send(path + '/end', 'POST');
      else if (battlePublisher && match && connected) {
        await send(path + '/match', 'POST', { action: match.status==='running'?'forfeit':'decline', matchId: match.id });
      } else if (stageSeatId && connected) {
        await send(path + '/stage', 'POST', { action: 'leave', seatId: stageSeatId });
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
  const canVote = connected && !!user && !grant.host && !battlePublisher && !match?.voted && !starting && seconds > 0;
  const pinned = state?.messages.find(message => message.id === state.room.pinned_id);
  const contestants=match?[{id:grant.hostId,name:'Host',score:match.host_score},...(four
    ?roster.map(person=>({id:person.user_id,name:person.display_name,score:person.score}))
    :[{id:match.guest_id,name:match.guest_name,score:match.guest_score}])]:[];
  const tiles = [
    { id: grant.hostId, name: videos[grant.hostId]?.name ?? 'Host' },
    ...(split ? contestants.slice(1)
      : stageGuests.map(seat => ({ id: seat.user_id, name: seat.display_name }))),
  ];
  const cards=(state?.stage?.capacity??7)+1;
  const grid=!split&&!spotlight&&stageGuests.length>0;
  const layout = split ? (four?' battle-stage battle-four':' split battle-stage') : spotlight ? ' spotlight-stage' + (fullscreen ? ' spotlight-fullscreen' : '') : grid ? ' grid-stage' : '';
  const fitAllowed=!split&&!grid&&(!spotlight||fullscreen);

  return <div className={'arena'+(docked?' arena-docked':'')} ref={arena}>
    <div className={'arena-media' + layout + (fit&&fitAllowed ? ' fit' : '')} aria-label="LIVE video stage" data-tile-count={tiles.length} data-layout-cards={grid?cards:undefined}
      style={{ '--rail-rows': Math.max(1, Math.ceil((tiles.length - 1) / 2)), '--grid-rows':cards/2 } as CSSProperties}>
      {tiles.map(tile => <StageTile key={tile.id} identity={tile.id} name={tile.name} track={videos[tile.id]?.track}
        host={tile.id===grant.hostId} featured={tile.id === spotlight} />)}
      {grid&&Array.from({length:Math.max(0,cards-tiles.length)},(_,index)=><div className="arena-tile vacant" key={'seat-'+index} aria-label="Open guest seat">
        <UsersRound size={21} aria-hidden="true"/>
      </div>)}
    </div>
    {connected && grant.host && spotlight && <button className="arena-action arena-pill arena-focus-toggle" disabled={pending}
      onClick={() => void stageAction({ action: 'fullscreen', userId: spotlight, enabled: !fullscreen })}>
      {fullscreen ? <LayoutGrid size={16} /> : <Expand size={16} />}
      {fullscreen ? 'Restore guest tiles' : 'Maximize spotlight'}
    </button>}
    <div ref={audioBox} hidden />
    <GiftEffects events={state?.gifts} now={state?.now} />
    <div className="arena-top">
      <span className={'arena-status' + (connected && !state?.room.ended ? ' on-air' : '')} role="status">
        {state?.room.ended ? 'Broadcast ended.' : grant.guest && state?.room.guest_access === false ? 'Guest watching is off.' : connected ? 'LIVE' : status}
      </span>
      <div className="arena-buttons">
        {grant.host&&connected&&!battle&&!seats.length&&<button className="arena-action" aria-label="LIVE challenge" title="LIVE challenge"
          aria-expanded={drawer==='challenge'} onClick={()=>toggleDrawer('challenge')}><Swords size={18}/></button>}
        {fitAllowed&&<button className="arena-action" aria-label={fit ? 'Fill screen' : 'Fit entire video'} title={fit ? 'Fill screen' : 'Fit entire video'} aria-pressed={fit} onClick={() => setFit(value => !value)}>{fit ? <Maximize size={18} /> : <Minimize size={18} />}</button>}
        {connected && grant.host && <button className="arena-action" aria-label="Share LIVE" title="Share LIVE" onClick={() => toggleDrawer('share')} aria-expanded={drawer === 'share'}><Share2 size={18} /></button>}
        {connected && grant.host && <button className="arena-action" aria-label="Guest stage" title="Guest stage"
          onClick={() => toggleDrawer('stage')} aria-expanded={drawer === 'stage'}><UsersRound size={18} /></button>}
        {canModerate && <button className="arena-action" aria-label="Moderation" title="Moderation" onClick={() => toggleDrawer('moderation')} aria-expanded={drawer === 'moderation'}><Shield size={18} /></button>}
        <button className="arena-action" aria-label={grant.host ? 'End broadcast' : 'Leave'} title={grant.host ? 'End broadcast' : 'Leave'} disabled={pending} onClick={exit}><X size={21} /></button>
      </div>
    </div>
    <div className="arena-match">
      {connected && mySeat && !mySeat.on_stage && <section className="battle" aria-label="Stage invitation">
        <strong>The host invited you on stage</strong>
        <p>Joining turns on your camera and microphone.</p>
        <div className="arena-buttons">
          <button className="primary" disabled={pending} onClick={() => void stageAction({ action: 'accept', seatId: mySeat.id })}>Accept stage invite</button>
          <button className="secondary" disabled={pending} onClick={() => void stageAction({ action: 'decline', seatId: mySeat.id })}>Decline stage invite</button>
        </div>
      </section>}
      {match?.status === 'running' && <section className="battle compact-battle" aria-label={four?'Four-person scoreboard':'1v1 scoreboard'}>
        <div className="battle-head"><span><Swords size={16} /> {four?'Four-person challenge':'1v1 LIVE'}</span><strong>{countdown}</strong></div>
        <div className="battle-score" style={{'--contestants':contestants.length} as CSSProperties}>
          {contestants.map(person=><div key={person.id}><small title={person.name}>{person.name}</small><strong>{person.score}</strong>
            {canVote&&<button className="secondary" disabled={pending} aria-label={'Vote for '+person.name}
              onClick={()=>void matchAction('vote',{contestantId:person.id})}><Heart size={14}/> Vote</button>}
          </div>)}
        </div>
        <div className="arena-buttons">
          {match.voted && <small>Vote recorded{match.voted_for?' for '+contestants.find(person=>person.id===match.voted_for)?.name:''}.</small>}
          {isPublisher && <button className="link" disabled={pending} onClick={() => {
            if (window.confirm('Forfeit this challenge?')) void matchAction('forfeit');
          }}>Forfeit match</button>}
        </div>
      </section>}
      {match?.status==='finished'&&!seats.length&&<section className="battle" aria-label="Match result">
        <div className="battle-head"><span><Swords size={17}/> {match.winner_id===null?'Draw':
          (contestants.find(person=>person.id===match.winner_id)?.name??'Contestant')+' wins'}</span></div>
        <div className="battle-score" style={{'--contestants':contestants.length} as CSSProperties}>
          {contestants.map(person=><div key={person.id}><small title={person.name}>{person.name}</small><strong>{person.score}</strong></div>)}
        </div>
        {match.outcome!=='time'&&<small>Challenge ended early.</small>}
      </section>}
      {match&&['invited','ready'].includes(match.status)&&(grant.host||invited||battlePublisher)&&<div className="battle">
        <p>{invited ? (four?'The host invited you to a four-person LIVE challenge.':'The host invited you to a 1v1 LIVE challenge.') :
          four ? 'Waiting for challengers · '+roster.filter(person=>person.status==='ready').length+'/3 ready' :
            match.status==='ready'?'Waiting for the challenger’s camera…':'Invited '+match.guest_name+'.'}</p>
        <div className="arena-buttons">
          {connected&&invited&&<>
            <button className="primary" disabled={pending} onClick={()=>void matchAction('accept')}>Accept challenge</button>
            <button className="secondary" disabled={pending} onClick={()=>void matchAction('decline')}>Decline</button>
          </>}
          {grant.host&&connected&&<button className="secondary" disabled={pending} onClick={()=>void matchAction('cancel')}>Cancel challenge</button>}
        </div>
      </div>}
      {match?.status==='cancelled'&&!seats.length&&<p className="hint">Challenge {match.outcome==='guest_removed'?'ended':match.outcome}.</p>}
    </div>
    <div className="arena-foot" ref={footer}>
      {!hideChat && <div className="arena-conversation">
        {pinned && <p className="pinned"><strong>Pinned · @{pinned.handle}</strong> {pinned.body}</p>}
        <LiveChatLog messages={state?.messages??[]} pinned={pinned?.id} viewerId={connected?user?.id:undefined}
          docked={docked} report={setReporting} />
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
        <button className="arena-action" aria-label={hideChat ? 'Show chat' : 'Hide chat'} title={hideChat ? 'Show chat' : 'Hide chat'} aria-pressed={!hideChat}
          onClick={() => setHideChat(value => !value)}><MessageCircle size={19} /></button>
        {enableAudio && <button className="arena-action arena-pill" onClick={() => void connection.current?.startAudio().catch(() => setError('Could not enable audio.'))}>Enable sound</button>}
        {connected&&user&&!grant.host&&state?.hostProfile&&<button className="arena-action arena-pill" disabled={pending}
          aria-pressed={state.hostProfile.following} onClick={()=>{
            const profile=state.hostProfile!;
            void perform(()=>send('/creators/'+profile.handle+'/follow','PUT',{enabled:!profile.following}));
          }}>{state.hostProfile.following?'Following host':'Follow host'}</button>}
        {connected && !isPublisher && <button className="arena-action arena-pill arena-gift-button" aria-label="LIVE gifts"
          aria-expanded={drawer === 'gifts'} onClick={() => user ? toggleDrawer('gifts') : signIn()}><Gift size={19} /> Gifts</button>}
        {connected && isPublisher && <>
          <button className="arena-action" aria-label={camera ? 'Turn camera off' : 'Turn camera on'} title={camera ? 'Turn camera off' : 'Turn camera on'} disabled={pending || effectPending} onClick={() => toggleDevice('camera')}>{camera ? <Camera size={19} /> : <CameraOff size={19} />}</button>
          <button className="arena-action" aria-label={mic ? 'Mute microphone' : 'Unmute microphone'} title={mic ? 'Mute microphone' : 'Unmute microphone'} disabled={pending} onClick={() => toggleDevice('mic')}>{mic ? <Mic size={19} /> : <MicOff size={19} />}</button>
          <button className="arena-action arena-pill" aria-label="Camera effects" aria-expanded={drawer === 'effects'} onClick={() => toggleDrawer('effects')}><Sparkles size={18} /> Effects</button>
        </>}
        {connected && stageSeatId && <button className="arena-action" aria-label="Leave stage" title="Leave stage" disabled={pending}
          onClick={() => void stageAction({ action: 'leave', seatId: stageSeatId })}><LogOut size={18} /></button>}
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
      {stageMediaError && stageSeatId && <div className="arena-notice"><p role="alert">{stageMediaError}</p>
        <button className="link" onClick={() => setCameraRetry(value => value + 1)}>Retry camera and mic</button>
      </div>}
      {liveNotice && drawer !== 'stage' && <p className="arena-notice" role="status">{liveNotice}</p>}
      {(error || snapshot?.error) && drawer !== 'stage' && <p className="arena-notice error" role="alert">{error || snapshot?.error}</p>}
    </div>
    {drawer && <section className="arena-drawer" aria-label={drawerTitles[drawer]}>
      <div className="arena-drawer-heading">
        <h3>{drawerTitles[drawer]}</h3>
        <button className="arena-action" onClick={() => setDrawer(null)} aria-label={'Close ' + drawerTitles[drawer]}><X size={19} /></button>
      </div>
      {drawer === 'share' && connected && grant.host && <>
        <LiveInvitePlans roomId={grant.id}/>
        <button className="secondary" onClick={()=>setDrawer('promote')}>Boost LIVE</button>
      </>}
      {drawer === 'promote' && connected && grant.host && <Promote liveId={grant.id}/>}
      {drawer === 'moderation' && canModerate && state && user && <LiveModeration path={path} user={user} hostId={grant.hostId} chatOpen={state.room.chat_open}
        guestAccess={state.room.guest_access} messages={state.messages} pinnedId={state.room.pinned_id} revision={revision} ended={state.room.ended} onChange={sync} />}
      {drawer === 'stage' && grant.host && connected && <>
        <StageControls path={path} hostId={grant.hostId} seats={seats} capacity={state?.stage?.capacity ?? 7}
          spotlight={spotlight} revision={revision} pending={pending} battle={battle} onCommand={stageAction} />
        {liveNotice && <p role="status">{liveNotice}</p>}
        {(error || snapshot?.error) && <p className="error" role="alert">{error || snapshot?.error}</p>}
      </>}
      {drawer==='challenge'&&grant.host&&connected&&<ChallengeSetup pending={pending} submit={async(action,data)=>{
        const ok=await matchAction(action,data);
        if(ok)setDrawer(null);
        return ok;
      }}/>}
      {drawer==='challenge'&&error&&<p className="error" role="alert">{error}</p>}
      {drawer === 'gifts' && connected && user && !isPublisher &&
        <LiveGifts path={path} liveCode={grant.shareCode} liveRoom={grant.id} recipients={tiles} refresh={sync} />}
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
