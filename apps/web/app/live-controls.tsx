'use client';

import { useState } from 'react';
import { send, useData, type Person } from './client';
import type { ChatLine } from './live-broadcast';

type Member = Person & { moderator: boolean; muted_until: string | null; banned: boolean; connected: boolean };
type Report = { target_id: string; handle: string; reason: string; updated_at: string };
type Audit = { id: string; action: string; actor: string; target: string | null; created_at: string };
type ModerationData = { people: Member[]; keywords: string[]; audit: Audit[]; reports: Report[]; guests: number };

export default function LiveModeration({ path, user, hostId, chatOpen, guestAccess, messages, pinnedId, revision, ended, onChange }: {
  path: string; user: Person; hostId: string; chatOpen: boolean; messages: ChatLine[];
  guestAccess: boolean; pinnedId: string | null; revision: number; ended: boolean; onChange: () => void;
}) {
  const result = useData<ModerationData>(path + '/moderation', revision);
  const data = result?.data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [timeout, setTimeoutMinutes] = useState(5);
  const [keywords, setKeywords] = useState<string>();
  const host = user.id === hostId;
  const disabled = pending || ended;

  async function act(action: string, payload: object = {}) {
    if (disabled) return;
    setPending(true);
    setError('');
    try {
      await send(path + '/moderation', 'POST', { action, ...payload });
      onChange();
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }

  return <section className="live-mod" aria-label="LIVE moderation">
    <header className="battle-head"><h3>Room moderation</h3>
      <button className="secondary" disabled={disabled} onClick={() => void act('chat', { open: !chatOpen })}>
        {chatOpen ? 'Close chat' : 'Open chat'}
      </button>
    </header>
    {host && <div className="arena-buttons">
      <button className="secondary" disabled={disabled} onClick={() => void act('guests', { open: !guestAccess })}>
        {guestAccess ? 'Turn off guest watching' : 'Allow guest watching'}
      </button>
      {data && <small>{data.guests} watching as guests</small>}
    </div>}
    {!result && <p role="status">Loading moderation…</p>}
    {data && <>
      <form className="inline" onSubmit={event => {
        event.preventDefault();
        void act('keywords', { words: (keywords ?? data.keywords.join(', ')).split(',').map(word => word.trim()).filter(Boolean) });
      }}>
        <input aria-label="Blocked keywords" placeholder="Blocked keywords, comma-separated"
          value={keywords ?? data.keywords.join(', ')} onChange={event => setKeywords(event.target.value)} maxLength={1550} />
        <button className="secondary" disabled={disabled}>Save filters</button>
      </form>
      <details open>
        <summary>People</summary>
        <label className="timeout-select">Chat timeout
          <select value={timeout} onChange={event => setTimeoutMinutes(Number(event.target.value))}>
            {[1, 5, 15, 60].map(minutes => <option key={minutes} value={minutes}>{minutes} min</option>)}
          </select>
        </label>
        <div className="list">
          {data.people.filter(person => person.id !== user.id && person.id !== hostId).map(person => {
            const muted = person.muted_until && new Date(person.muted_until).getTime() > Date.now();
            const protectedRole = person.moderator && !host;
            return <div className="mod-row" key={person.id}>
              <p><strong>@{person.handle}</strong> <small>{[person.moderator && 'Moderator', person.banned && 'Banned',
                muted && 'Timed out', !person.connected && 'Offline'].filter(Boolean).join(' · ')}</small></p>
              {!protectedRole && <div className="arena-buttons">
                {host && !person.banned && <button className="secondary" disabled={disabled} onClick={() => void act(person.moderator ? 'revoke' : 'appoint', { userId: person.id })}>
                  {person.moderator ? 'Remove moderator' : 'Make moderator'}
                </button>}
                {!person.banned && <button className="secondary" disabled={disabled} onClick={() => void act(muted ? 'unmute' : 'mute', { userId: person.id, minutes: timeout })}>
                  {muted ? 'End timeout' : 'Time out'}
                </button>}
                <button className="secondary" disabled={disabled} onClick={() => {
                  if (person.banned || window.confirm('Remove @' + person.handle + ' and block rejoining this LIVE?')) {
                    void act(person.banned ? 'unban' : 'ban', { userId: person.id });
                  }
                }}>{person.banned ? 'Unban' : 'Ban from LIVE'}</button>
              </div>}
            </div>;
          })}
        </div>
      </details>
      <details>
        <summary>Chat messages</summary>
        <div className="list">
          {messages.map(message => <div className="mod-row" key={message.id}>
            <p><strong>@{message.handle}</strong> {message.body}</p>
            <div className="arena-buttons">
              <button className="secondary" disabled={disabled} onClick={() => void act(message.id === pinnedId ? 'unpin' : 'pin', { messageId: message.id })}>
                {message.id === pinnedId ? 'Unpin' : 'Pin'}
              </button>
              <button className="secondary" disabled={disabled} onClick={() => void act('delete', { messageId: message.id })}>Delete message</button>
            </div>
          </div>)}
        </div>
      </details>
      <details>
        <summary>Reports ({data.reports.length})</summary>
        <div className="list">
          {data.reports.map((report, index) => <div className="mod-row" key={report.target_id + ':' + index}>
            <p><strong>@{report.handle}</strong> {report.reason}</p>
            <button className="secondary" disabled={disabled} onClick={() => void act('dismissReports', { userId: report.target_id })}>Dismiss reports for @{report.handle}</button>
          </div>)}
        </div>
      </details>
      <details>
        <summary>Moderation log</summary>
        <div className="list">
          {!data.audit.length && <p className="hint">No moderation actions yet.</p>}
          {data.audit.map(entry => <p key={entry.id}><strong>@{entry.actor}</strong> · {entry.action}
            {entry.target && ' · @' + entry.target} <small>{new Date(entry.created_at).toLocaleTimeString('en-KE')}</small></p>)}
        </div>
      </details>
    </>}
    {(error || result?.error) && <p className="error" role="alert">{error || result?.error}</p>}
  </section>;
}
