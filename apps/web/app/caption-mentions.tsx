'use client';

import { AtSign } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { api, type Person } from './client';

const maxLength = 500;
const handleCharacters = /^[a-z0-9_]*/i;

function mentionAt(value: string, caret: number) {
  const match = /(?:^|[^\p{L}\p{N}_.@])@([a-z0-9_]{0,24})$/iu.exec(value.slice(0, caret));
  if (!match) return null;
  const query = match[1];
  return { query, start: caret - query.length - 1, end: caret + (handleCharacters.exec(value.slice(caret))?.[0].length ?? 0) };
}

export function CaptionText({ caption, open }: { caption: string; open: (handle: string) => void }) {
  let end = 0;
  return <>{Array.from(caption.matchAll(/(^|[^\p{L}\p{N}_.@])(@[a-z0-9_]{3,24})(?![\p{L}\p{N}_])/giu), match => {
    const start = match.index + match[1].length;
    const text = caption.slice(end, start);
    const token = match[2];
    end = start + token.length;
    return <span key={start}>{text}<button type="button" className="caption-handle"
      onClick={() => open(token.slice(1).toLowerCase())}>{token}</button></span>;
  })}{caption.slice(end)}</>;
}

export default function CaptionMentions() {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const caretToRestore = useRef<number | null>(null);
  const acceptedCaret = useRef<number | null>(null);
  const [value, setValue] = useState('');
  const [mention, setMention] = useState<ReturnType<typeof mentionAt>>(null);
  const [results, setResults] = useState<{ query: string; people: Person[]; error?: string }>();
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState('');
  const query = mention?.query.toLowerCase();
  const current = query !== undefined && results?.query === query ? results : undefined;
  const people = current?.people ?? [];
  const optionId = (index: number) => id + '-mention-' + index;

  useEffect(() => {
    if (query === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<Person[]>('/creator-search?' + new URLSearchParams({ q: query }), { signal: controller.signal })
        .then(people => { if (!controller.signal.aborted) setResults({ query, people }); })
        .catch(() => {
          if (!controller.signal.aborted) setResults({ query, people: [], error: 'Suggestions unavailable. You can still enter a handle.' });
        });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    if (caretToRestore.current === null) return;
    const caret = caretToRestore.current;
    caretToRestore.current = null;
    field.current?.focus();
    field.current?.setSelectionRange(caret, caret);
  }, [value]);

  function inspect(element: HTMLTextAreaElement) {
    if (element.selectionStart === acceptedCaret.current && element.selectionEnd === acceptedCaret.current) return;
    acceptedCaret.current = null;
    const next = element.selectionStart === element.selectionEnd ? mentionAt(element.value, element.selectionStart) : null;
    if (next?.query !== mention?.query) setActive(0);
    setMention(next);
  }

  function insert(person: Person) {
    if (!mention) return;
    const before = value.slice(0, mention.start) + '@' + person.handle;
    const after = value.slice(mention.end);
    const separator = !after || /^[@\p{L}\p{N}_]/u.test(after) ? ' ' : '';
    if (before.length + after.length > maxLength) {
      setNotice('This handle exceeds the 500-character limit.');
      return;
    }
    const space = before.length + after.length < maxLength ? separator : '';
    caretToRestore.current = before.length + space.length;
    acceptedCaret.current = caretToRestore.current;
    setValue(before + space + after);
    setMention(null);
    setNotice('');
  }

  function addMention() {
    const element = field.current;
    if (!element) return;
    const start = element.selectionStart;
    const before = value.slice(0, start);
    const tag = /[\p{L}\p{N}_.@]$/u.test(before) ? ' @' : '@';
    const next = before + tag + value.slice(element.selectionEnd);
    if (next.length > maxLength) {
      setNotice('The caption has reached 500 characters.');
      return;
    }
    const caret = before.length + tag.length;
    caretToRestore.current = caret;
    acceptedCaret.current = null;
    setValue(next);
    setMention(mentionAt(next, caret));
    setActive(0);
    setNotice('');
  }

  function navigate(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      acceptedCaret.current = field.current?.selectionStart ?? null;
      setMention(null);
    } else if (people.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActive(index => (index + (event.key === 'ArrowDown' ? 1 : people.length - 1)) % people.length);
    } else if (people.length && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      insert(people[active] ?? people[0]);
    }
  }

  return <div className="caption-editor" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setMention(null);
  }}>
    <label htmlFor={id}>Caption</label>
    <textarea ref={field} id={id} name="caption" value={value} maxLength={maxLength} required
      placeholder="Write a caption and @mention creators" aria-autocomplete="list"
      aria-controls={mention ? id + '-matches' : undefined} aria-activedescendant={people[active] ? optionId(active) : undefined}
      onChange={event => { acceptedCaret.current = null; setValue(event.currentTarget.value); inspect(event.currentTarget); setNotice(''); }}
      onSelect={event => inspect(event.currentTarget)} onKeyDown={navigate} />
    <div className="caption-tools">
      <button type="button" className="secondary" onMouseDown={event => event.preventDefault()} onClick={addMention}>
        <AtSign size={17} aria-hidden="true" /> Mention
      </button>
      <span>{value.length}/{maxLength}</span>
    </div>
    {mention && <div className="caption-matches">
      <div role="listbox" id={id + '-matches'} aria-label="Creator suggestions">
        {people.map((person, index) => <button type="button" key={person.id} id={optionId(index)} role="option"
          aria-selected={active === index} tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => insert(person)}>
          <span className="avatar" aria-hidden="true">{person.display_name.slice(0, 1).toUpperCase()}</span>
          <span><strong>@{person.handle}</strong><small>{person.display_name}</small></span>
        </button>)}
      </div>
      {!people.length && <p role="status">{current?.error ?? (!current ? 'Looking for creators…'
        : query ? 'No matching handles.' : 'Type a handle to find a creator.')}</p>}
    </div>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
