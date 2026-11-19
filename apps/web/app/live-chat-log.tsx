'use client';

import { ArrowDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type ChatLine = { id: string; user_id?: string; handle: string; body: string };

export default function LiveChatLog({ messages, pinned, viewerId, docked, report }: {
  messages: ChatLine[]; pinned?: string; viewerId?: string; docked: boolean;
  report: (person: { id: string; label: string }) => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const rowPositions = useRef(new Map<string, number>());
  const [atLatest, setAtLatest] = useState(true);
  const visibleMessages = messages.filter(message => message.id !== pinned);
  const firstId = visibleMessages[0]?.id;
  const lastId = visibleMessages.at(-1)?.id;

  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = log.current;
    if (!element || !following.current) {
      rowPositions.current.clear();
      return;
    }
    element.scrollTop = element.scrollHeight;
    const previous = rowPositions.current;
    const next = new Map<string, number>();
    const motion = docked && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll<HTMLDivElement>('[data-message-id]')) {
      const id = row.dataset.messageId!;
      const y = row.offsetTop - element.scrollTop;
      if (y + row.offsetHeight < 0 || y > element.clientHeight) continue;
      next.set(id, y);
      const shift = (previous.get(id) ?? y) - y;
      if (motion && shift > 1 && row.getBoundingClientRect().bottom > top) {
        row.animate([{ transform: 'translateY(' + shift + 'px)' }, { transform: 'translateY(0)' }],
          { duration: 240, easing: 'ease-out' });
      }
    }
    rowPositions.current = next;
  }, [docked, firstId, lastId, pinned]);

  return <div className="live-chat-stream">
    <div className="live-chat" ref={log} role="log" aria-label="LIVE chat" tabIndex={visibleMessages.length ? 0 : undefined}
      onScroll={event => {
        const element = event.currentTarget;
        const latest = element.scrollHeight - element.scrollTop - element.clientHeight < 12;
        following.current = latest;
        setAtLatest(latest);
      }}>
      {!visibleMessages.length && docked && <p className="live-chat-empty">Comments appear here</p>}
      {visibleMessages.map(message => <div key={message.id} className="live-message" data-message-id={message.id}>
        <p><strong>@{message.handle}</strong> {message.body}</p>
        {viewerId && message.user_id && message.user_id !== viewerId && <button className="link" onClick={() =>
          report({ id: message.user_id!, label: '@' + message.handle })}>Report</button>}
      </div>)}
    </div>
    {!atLatest && <button className="secondary live-chat-latest" onClick={() => {
      following.current = true;
      setAtLatest(true);
      if (log.current) log.current.scrollTop = log.current.scrollHeight;
    }}><ArrowDown size={14} /> Latest</button>}
  </div>;
}
