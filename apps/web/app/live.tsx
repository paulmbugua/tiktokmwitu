
'use client';

import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { send, useData, type Person } from './client';
import Broadcast, { type Grant } from './live-broadcast';

type Listing = { enabled: boolean; rooms: Array<Person & { viewers: number; host_id: string }> };

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

  if (grant && user) return <Broadcast key={grant.id} grant={grant} user={user} leave={() => { setGrant(null); setRevision(value => value + 1); }} />;
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
