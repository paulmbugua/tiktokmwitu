'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef, useState } from 'react';
import { imageUrl } from './client';

export default function PhotoGallery({ images }: { images: string[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const go = (next: number) => {
    const node = track.current;
    if (node) node.scrollTo({
      left: Math.max(0, Math.min(images.length - 1, next)) * node.clientWidth,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  };
  return <section className="post-gallery" aria-label="Photo gallery">
    <div className="post-gallery-track" ref={track} tabIndex={images.length > 1 ? 0 : undefined}
      onScroll={event => {
        const node = event.currentTarget;
        if (node.clientWidth) setIndex(Math.min(images.length - 1, Math.max(0, Math.round(node.scrollLeft / node.clientWidth))));
      }}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        go(index + (event.key === 'ArrowRight' ? 1 : -1));
      }}>
      {images.map((id, i) => <figure key={id}>
        <img src={imageUrl(id)} crossOrigin="anonymous" alt={`Photo ${i + 1} of ${images.length}`} loading="lazy" draggable={false} />
      </figure>)}
    </div>
    {images.length > 1 && <>
      <span className="post-gallery-count" aria-live="polite">{index + 1} / {images.length}</span>
      <button type="button" className="icon gallery-prev" aria-label="Previous photo" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft size={20} /></button>
      <button type="button" className="icon gallery-next" aria-label="Next photo" disabled={index === images.length - 1} onClick={() => go(index + 1)}><ChevronRight size={20} /></button>
      <div className="post-gallery-dots" aria-hidden="true">{images.map((id, i) => <span key={id} className={index === i ? 'active' : ''} />)}</div>
    </>}
  </section>;
}
