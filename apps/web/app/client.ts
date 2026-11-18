
'use client';

import { useEffect, useState } from 'react';

export type Person = { id: string; handle: string; display_name: string };
export type Profile = Person & { followers: number; following_count: number; following: boolean };
export type Video = {
  id: string; caption: string; county: string; handle: string; creator_id: string;
  display_name: string; likes: number; comments: number; liked: boolean; following: boolean;
};
export type Cursor = { at: string; after: string };
export type Feed = { items: Video[]; next: Cursor | null };
export type Comment = { id: string; handle: string; body: string };
export type Inbox = { handle: string; display_name: string; body: string };
export type Message = { id: string; body: string; mine: boolean };

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('x-mwitu-request', '1');
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch('/api' + path, { ...options, headers, cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message ?? 'Could not connect to Tiktok mwitu. Try again.');
  return result as T;
}

export const send = <T = unknown>(path: string, method: string, body?: object) =>
  api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export function useData<T>(path: string | null, revision = 0) {
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>();
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult({ path, data }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ path, error: error.message }); });
    return () => controller.abort();
  }, [path, revision]);
  return result?.path === path ? result : undefined;
}
