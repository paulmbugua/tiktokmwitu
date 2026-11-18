'use client';

import { useState, type FormEvent } from 'react';
import { mediaUrl, send, useData, type Person } from '../client';

type Report = { id: string; caption: string; handle: string; total: number; reasons: string[] };
type LiveReport = { id: string; handle: string; ended_at: string | null; total: number; reasons: string[] };

export default function Moderation() {
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const session = useData<Person>('/admin/me', version);
  const reports = useData<Report[]>(session?.data ? '/admin/reports' : null, version);
  const live = useData<LiveReport[]>(session?.data ? '/admin/live-reports' : null, version);

  function refresh() {
    setVersion(value => value + 1);
  }

  async function act(action: () => Promise<unknown>, message = '') {
    if (pending) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
      refresh();
    } catch (error) {
      setError((error as Error).message);
      refresh();
    } finally {
      setPending(false);
    }
  }

  function logIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const credentials = Object.fromEntries(new FormData(event.currentTarget));
    void act(() => send('/auth/login', 'POST', credentials));
  }

  return <main className="moderation">
    <header>
      <div><p className="hint">Tiktok mwitu</p><h1>Moderation</h1></div>
      {session?.data && <button className="secondary" disabled={pending}
        onClick={() => void act(() => send('/auth/logout', 'POST'))}>Log out @{session.data.handle}</button>}
    </header>
    {!session && <p role="status">Checking your session…</p>}
    {session?.error && <form className="moderation-login" onSubmit={logIn}>
      <p className="hint">{session.error}</p>
      <label>Handle<input name="handle" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <button className="primary" disabled={pending}>Log in</button>
    </form>}
    {session?.data && <section aria-labelledby="reports-heading">
      <header><h2 id="reports-heading">Video reports</h2><button className="secondary" onClick={refresh}>Refresh</button></header>
      {reports?.error && <p className="error">{reports.error}</p>}
      {!reports && <p role="status">Loading reports…</p>}
      {reports?.data?.length === 0 && <p role="status">No pending reports.</p>}
      {reports?.data?.map(report => <article key={report.id} className="moderation-report">
        <div>
          <h3>{report.caption}</h3>
          <p className="hint">@{report.handle} · {report.total} {report.total === 1 ? 'report' : 'reports'}</p>
          <ul>{report.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        </div>
        <video controls preload="none" playsInline src={mediaUrl(report.id)} aria-label={'Video by @' + report.handle} />
        <div className="moderation-actions">
          <button className="secondary" disabled={pending}
            onClick={() => void act(() => send('/admin/reports/' + report.id, 'POST', { action: 'dismiss' }), 'Reports dismissed.')}>Dismiss reports</button>
          <button className="secondary danger" disabled={pending}
            onClick={() => {
              if (!window.confirm('Remove this video from Tiktok mwitu?')) return;
              void act(() => send('/admin/reports/' + report.id, 'POST', { action: 'remove' }), 'Video removed.');
            }}>Remove video</button>
        </div>
      </article>)}
    </section>}
    {session?.data && <section aria-labelledby="live-reports-heading">
      <header><h2 id="live-reports-heading">LIVE reports</h2><button className="secondary" onClick={refresh}>Refresh LIVE reports</button></header>
      {live?.error && <p className="error">{live.error}</p>}
      {!live && <p role="status">Loading LIVE reports…</p>}
      {live?.data?.length === 0 && <p role="status">No pending LIVE reports.</p>}
      {live?.data?.map(report => <article className="moderation-report" key={report.id}>
        <div><h3>@{report.handle}</h3><p className="hint">{report.total} reports · {report.ended_at ? 'Ended' : 'Active'}</p>
          <ul>{report.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        </div>
        <div className="moderation-actions">
          <button className="secondary" disabled={pending} onClick={() =>
            void act(() => send('/admin/live-reports/' + report.id, 'POST', { action: 'dismiss' }), 'LIVE reports dismissed.')}>Dismiss LIVE reports</button>
          {!report.ended_at && <button className="secondary danger" disabled={pending} onClick={() => {
            if (window.confirm('End this LIVE broadcast for everyone?')) {
              void act(() => send('/admin/live-reports/' + report.id, 'POST', { action: 'end' }), 'Broadcast ended.');
            }
          }}>End LIVE</button>}
        </div>
      </article>)}
    </section>}
    {notice && <p className="toast" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </main>;
}
