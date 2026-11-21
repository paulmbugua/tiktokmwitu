'use client';

import { Heart } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { send } from './client';

export type LikeGoal = { total: number; count: number; target: number; endsAt: number | null };

export default function LiveHearts({ path, code, viewer, goal }: {
  path: string; code?: string; viewer: boolean; goal?: LikeGoal;
}) {
  const queued = useRef(0);
  const previous = useRef(goal?.total);
  const serial = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hearts, setHearts] = useState<number[]>([]);
  const [error, setError] = useState('');

  function animate(amount: number) {
    const next = Array.from({ length: amount }, () => ++serial.current);
    setHearts(current => [...current, ...next].slice(-14));
  }

  useEffect(() => {
    if (goal && previous.current !== undefined && goal.total > previous.current && !viewer) {
      animate(Math.min(6, goal.total - previous.current));
    }
    previous.current = goal?.total;
  }, [goal?.total, viewer]); // Animate the shared count for the host.

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, [path]);

  function tap() {
    animate(1);
    if (queued.current < 20) queued.current++;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      const taps = queued.current;
      queued.current = 0;
      timer.current = null;
      void send(path + '/likes', 'POST', { taps, code }).then(() => setError(''))
        .catch(() => setError('Could not send likes. Tap to try again.'));
    }, 1200);
  }

  return <div className="live-hearts">
    <div className="live-heart-float" aria-hidden="true">{hearts.map(id =>
      <Heart key={id} className={'live-heart-color-' + id % 3} fill="currentColor"
        onAnimationEnd={() => setHearts(current => current.filter(heart => id !== heart))} />)}</div>
    {viewer ? <button className="arena-action arena-pill" type="button" onClick={tap} aria-label="Tap to like LIVE">
      <Heart size={19} /> {goal?.total.toLocaleString('en-KE') ?? '0'}
    </button> : <span className="arena-action arena-pill"><Heart size={19} /> {goal?.total.toLocaleString('en-KE') ?? '0'}</span>}
    {error && <small className="live-heart-error" role="status">{error}</small>}
  </div>;
}
