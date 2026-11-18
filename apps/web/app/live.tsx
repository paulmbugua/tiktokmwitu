
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Radio, Send } from 'lucide-react';
import { Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import { send, useData, type Comment, type Person } from './client';

type Listing = { enabled: boolean; rooms: Array<Person & { viewers: number }> };
type Grant = { id: string; url: string; token: string; host: boolean };

export default function Live({ user, signIn }: { user: Person | null; signIn: () => void }) {
  const [revision, setRevision] = useState(0);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const listing = useData<Listing>(grant ? null : '/live', revision);
  useEffect(() => {
    if (grant || listing?.data?.enabled === false) return;
    const timer = setInterval(() => setRevision(value => value + 1), 7000);
    return () => clearInterval(timer);
  }, [grant, listing?.data?.enabled]);

  async function join(id?: string) {
    if (!user) { signIn(); return; }
    setPending(true);
    setError('');
    try { setGrant(await send<Grant>(id ? '/live/' + id + '/join' : '/live/start', 'POST')); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  if (grant) return <Broadcast grant={grant} leave={() => { setGrant(null); setRevision(value => value + 1); }} />;
  return <>
    <div className="list">
      {listing?.data?.rooms.map(room => <button key={room.id} className="row item" disabled={pending} onClick={() => void join(room.id)}>
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

function Broadcast({ grant, leave }: { grant: Grant; leave: () => void }) {
  const media = useRef<HTMLDivElement>(null);
  const connection = useRef<Room | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [enableAudio, setEnableAudio] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<Comment[]>([]);

  useEffect(() => {
    const parent = media.current;
    if (!parent) return;
    const room = new Room({
      adaptiveStream: true, dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h540.resolution },
    });
    connection.current = room;
    let open = true;
    room.on(RoomEvent.TrackSubscribed, track => {
      const element = track.attach();
      if (element instanceof HTMLVideoElement) element.playsInline = true;
      parent.append(element);
    });
    room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => element.remove()));
    room.on(RoomEvent.TrackUnpublished, (_track, participant) => {
      if (participant.identity === grant.id) setStatus('The host paused the broadcast.');
    });
    room.on(RoomEvent.ParticipantDisconnected, participant => {
      if (participant.identity === grant.id) {
        setConnected(false);
        setStatus('Broadcast ended.');
        void room.disconnect();
      }
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => setEnableAudio(!room.canPlaybackAudio));
    room.on(RoomEvent.Reconnecting, () => setStatus('Reconnecting…'));
    room.on(RoomEvent.Reconnected, () => setStatus('Live'));
    room.on(RoomEvent.Disconnected, () => {
      if (!open) return;
      setConnected(false);
      setStatus('Broadcast ended.');
    });
    room.on(RoomEvent.DataReceived, (data, participant, _kind, topic) => {
      if (participant || topic !== 'mwitu-chat') return;
      try {
        const message: Comment = JSON.parse(new TextDecoder().decode(data));
        setMessages(previous => [...previous.slice(-59), message]);
      } catch { /* Ignore malformed room data. */ }
    });

    void (async () => {
      try {
        await room.connect(grant.url, grant.token);
        if (!open) return;
        if (grant.host) {
          await room.localParticipant.enableCameraAndMicrophone();
          if (!open) { await room.disconnect(); return; }
          const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
          if (track) {
            const element = track.attach();
            element.muted = true;
            parent.append(element);
          }
        }
        setStatus('Live');
        setConnected(true);
        setEnableAudio(!room.canPlaybackAudio && !grant.host);
      } catch {
        if (open) setError(grant.host ? 'Could not start the broadcast. Check camera, microphone and connection permissions.' : 'Could not join this broadcast.');
        await room.disconnect();
      }
    })();
    return () => {
      open = false;
      connection.current = null;
      room.removeAllListeners();
      void room.disconnect();
      parent.replaceChildren();
    };
  }, [grant]);

  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [messages]);

  async function chat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !connected) return;
    const form = event.currentTarget;
    setPending(true);
    setError('');
    try {
      await send('/live/' + grant.id + '/chat', 'POST', { body: new FormData(form).get('body') });
      form.reset();
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  return <>
    <div className="live-status"><span role="status">{status}</span><button className="secondary" onClick={leave}>{grant.host ? 'End broadcast' : 'Leave'}</button></div>
    <div className="live-media" ref={media} />
    {enableAudio && <button className="link" onClick={() => void connection.current?.startAudio().catch(() => setError('Could not enable audio.'))}>Enable sound</button>}
    <div className="list live-chat" ref={list} aria-live="polite">
      {messages.map(message => <p key={message.id}><strong>@{message.handle}</strong> {message.body}</p>)}
    </div>
    <form className="inline" onSubmit={chat}><input name="body" aria-label="Live chat message" placeholder="Chat with the room…" maxLength={300} required />
      <button className="primary" disabled={!connected || pending} aria-label="Send chat message"><Send size={17} /></button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}
