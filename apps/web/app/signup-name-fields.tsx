'use client';

import { useEffect, useState } from 'react';
import { api } from './client';

export default function SignupNameFields({ initialDisplayName = '' }: { initialDisplayName?: string }) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [ownHandle, setOwnHandle] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ name: string; handle: string | null }>();
  const name = displayName.trim();
  const suggested = suggestion?.name === name ? suggestion.handle : null;

  useEffect(() => {
    if (!name) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<{ handle: string | null }>('/auth/suggest-handle', {
        method: 'POST', body: JSON.stringify({ display_name: name }), signal: controller.signal,
      }).then(({ handle }) => {
        if (!controller.signal.aborted) setSuggestion({ name, handle });
      }).catch(() => {
        if (!controller.signal.aborted) setSuggestion({ name, handle: null });
      });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [name]);

  const note = ownHandle === null && suggested
    ? 'Suggested from your display name. You can edit it.'
    : 'Use 3–24 letters, numbers or underscores.';

  return <>
    <label>Display name<input name="display_name" autoComplete="nickname" maxLength={48} required
      value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>
    <label>Handle<input name="handle" autoComplete="username" pattern="[A-Za-z0-9_]{3,24}" maxLength={24} required
      aria-describedby="signup-handle-hint" value={ownHandle ?? suggested ?? ''}
      onChange={event => setOwnHandle(event.target.value)} /></label>
    <p id="signup-handle-hint" className="hint" aria-live="polite">{note}</p>
    {ownHandle !== null && suggested && ownHandle !== suggested &&
      <button type="button" className="link" onClick={() => setOwnHandle(null)}>Use @{suggested}</button>}
  </>;
}
