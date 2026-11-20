'use client';

import { Hash } from 'lucide-react';
import { useRef, useState } from 'react';

const maxLength = 500;
export const topicFromSearch = (value: string) => /^#([\p{L}\p{N}_]{1,48})$/u.exec(value)?.[1];

export function DescriptionText({ description, open }: { description: string; open: (tag: string) => void }) {
  let end = 0;
  return <>{Array.from(description.matchAll(/(^|[^\p{L}\p{N}_#])(#[\p{L}\p{N}_]{1,48})(?![\p{L}\p{N}_])/gu), match => {
    const start = match.index + match[1].length;
    const text = description.slice(end, start);
    const token = match[2];
    end = start + token.length;
    return <span key={start}>{text}<button type="button" className="description-tag"
      onClick={() => open(token)}>{token}</button></span>;
  })}{description.slice(end)}</>;
}

export default function VideoDescription() {
  const field = useRef<HTMLTextAreaElement>(null);
  const [length, setLength] = useState(0);

  function addHashtag() {
    const element = field.current;
    if (!element) return;
    const prefix = element.value.slice(0, element.selectionStart);
    const tag = /[\p{L}\p{N}_#]$/u.test(prefix) ? ' #' : '#';
    if (element.value.length - (element.selectionEnd - element.selectionStart) + tag.length > maxLength) return;
    element.setRangeText(tag, element.selectionStart, element.selectionEnd, 'end');
    setLength(element.value.length);
    element.focus();
  }

  return <div className="description-editor">
    <label htmlFor="video-description">Description</label>
    <textarea ref={field} id="video-description" name="caption" maxLength={maxLength} required
      placeholder="Describe your video and add #hashtags" onChange={event => setLength(event.currentTarget.value.length)} />
    <div className="description-tools">
      <button type="button" className="secondary" aria-label="Hashtag" title="Add hashtag"
        onMouseDown={event => event.preventDefault()} onClick={addHashtag}>
        <Hash size={19} aria-hidden="true" />
      </button>
      <span>{length}/{maxLength}</span>
    </div>
  </div>;
}
