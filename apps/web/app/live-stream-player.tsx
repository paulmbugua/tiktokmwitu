'use client';

import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import type Hls from 'hls.js';

function bunnyPath(value: string) {
  const url = new URL(value);
  const [, token, room, file] = url.pathname.split('/');
  if (!token?.startsWith('bcdn_token=') || !/^mwitu-[a-f0-9-]{36}$/.test(room ?? '') || !file) return null;
  return { url, token, room, file, expires: Number(new URLSearchParams(token).get('expires')) * 1000 };
}

export default function LiveStreamPlayer({ source }: { source: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [waiting, setWaiting] = useState(true);
  const [attempt, retry] = useState(0);
  const latest = useRef(source);
  latest.current = source;

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let closed = false;
    let player: Hls | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const failed = () => {
      setWaiting(true);
      timeout ??= setTimeout(() => retry(value => value + 1), 3500);
    };
    element.addEventListener('error', failed);
    void (async () => {
      if (element.canPlayType('application/vnd.apple.mpegurl')) {
        const load = () => {
          const signed = bunnyPath(latest.current);
          element.src = latest.current;
          void element.play().catch(() => undefined);
          if (signed?.expires && signed.expires > Date.now() + 10000) {
            refresh = setTimeout(() => {
              if (latest.current !== element.src) load();
              else failed();
            }, signed.expires - Date.now() - 10000);
          }
        };
        load();
      } else {
        const { default: HlsPlayer } = await import('hls.js');
        if (closed) return;
        if (!HlsPlayer.isSupported()) { failed(); return; }
        player = new HlsPlayer({
          lowLatencyMode: true, maxLiveSyncPlaybackRate: 1.15,
          xhrSetup(xhr, value) {
            const request = bunnyPath(value);
            const next = request && bunnyPath(latest.current);
            if (!request || !next || request.room !== next.room || request.url.origin !== next.url.origin ||
                request.expires >= next.expires) return;
            request.url.pathname = `/${next.token}/${request.room}/${request.file}`;
            xhr.open('GET', request.url.href, true);
          },
        });
        player.on(HlsPlayer.Events.ERROR, (_, error) => { if (error.fatal) failed(); });
        player.loadSource(latest.current);
        player.attachMedia(element);
      }
      await element.play().catch(() => undefined);
    })().catch(failed);
    return () => {
      closed = true;
      if (timeout) clearTimeout(timeout);
      if (refresh) clearTimeout(refresh);
      element.removeEventListener('error', failed);
      player?.destroy();
      element.removeAttribute('src');
      element.load();
    };
  }, [attempt]);

  return <div className="audience-stream">
    <video ref={video} autoPlay muted={muted} playsInline aria-label="LIVE broadcast"
      onPlaying={() => setWaiting(false)} />
    {waiting && <p role="status">Getting the LIVE video ready…</p>}
    <button className="arena-action" aria-label={muted ? 'Turn sound on' : 'Mute'} onClick={() => {
      if (video.current) {
        video.current.muted = !muted;
        void video.current.play().catch(() => undefined);
      }
      setMuted(!muted);
    }}>{muted ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
  </div>;
}
