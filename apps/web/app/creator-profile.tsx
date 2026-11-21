'use client';

import { Bookmark, Clapperboard, ExternalLink, Grid3X3, Heart, Images, Link, Menu, Pencil, Pin, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, mediaUrl, send, useData, type Feed, type Person, type Video } from './client';
import type { UploadJob } from './profile-upload';

const collections = [
  { title: 'Posts', icon: Grid3X3 },
  { title: 'Saved', icon: Bookmark },
  { title: 'Liked', icon: Heart },
] as const;
const count = new Intl.NumberFormat('en-KE', { notation: 'compact' });
const poster = (id: string) => mediaUrl(id).replace(/\.mp4$/, '.jpg');

function ProfileWebsite({ value, owner, changed }: { value: string; owner: boolean; changed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<{ previous: string; next: string }>();
  const website = saved?.previous === value ? saved.next : value;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const input = String(new FormData(event.currentTarget).get('website')).trim();
    const url = input && !input.includes('://') ? 'https://' + input : input;
    setSaving(true);
    setError('');
    try {
      const result = await send<{ website: string }>('/account/profile/website', 'PUT', { website: url });
      setSaved({ previous: value, next: result.website });
      setEditing(false);
      changed();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  if (!website && !owner) return null;
  const inApp = typeof navigator !== 'undefined' && /MwituFlutter\//.test(navigator.userAgent);
  return editing && owner ? <form className="creator-site-form" onSubmit={save}>
    <label>Website URL<input name="website" inputMode="url" autoCapitalize="none" spellCheck={false}
      maxLength={300} defaultValue={website} placeholder="https://example.com" autoFocus /></label>
    <div className="creator-actions">
      <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save website'}</button>
      <button type="button" className="secondary" disabled={saving} onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </form> : <div className="creator-site-row">
    {website && <a className="creator-site" href={website} rel="noopener noreferrer ugc" target={inApp ? '_self' : '_blank'}>
      <Link size={17} aria-hidden="true" /><span>{website.replace(/^https?:\/\//i, '')}</span><ExternalLink size={15} aria-hidden="true" />
    </a>}
    {owner && <button className={website ? 'icon' : 'secondary'} type="button"
      aria-label={website ? 'Edit website' : 'Add website'} title={website ? 'Edit website' : undefined}
      onClick={() => setEditing(true)}>
      {website ? <Pencil size={17} /> : <><Link size={16} /> Add website</>}
    </button>}
  </div>;
}

function ProfilePhoto({ kind, id, changed }: { kind: 'avatar' | 'cover'; id?: string | null; changed: () => void }) {
  const label = kind === 'avatar' ? 'Profile photo' : 'Cover photo';
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function update(file?: File) {
    if (busy) return;
    setError('');
    setSaved(false);
    if (file && file.size > 6 * 1024 * 1024) { setError('Choose a photo under 6 MB.'); return; }
    setBusy(true);
    const path = '/account/profile/images/' + kind;
    try {
      if (file) {
        const body = new FormData();
        body.append('image', file);
        await api(path, { method: 'PUT', body });
      } else await send(path, 'DELETE');
      setSaved(true);
      changed();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="creator-photo-control" data-kind={kind}>
    <input ref={picker} type="file" hidden aria-label={'Choose ' + label.toLowerCase()} disabled={busy}
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void update(file);
        }} />
    <button type="button" className="creator-photo-hit" aria-label={'Change ' + label.toLowerCase()}
      title={'Change ' + label.toLowerCase()} disabled={busy} onClick={() => picker.current?.click()}>
      <span className="creator-photo-pin"><Pin size={16} aria-hidden="true" /></span>
    </button>
    {id && <button type="button" className="creator-photo-remove" aria-label={'Remove ' + label.toLowerCase()}
      title={'Remove ' + label.toLowerCase()} disabled={busy}
      onClick={() => { if (window.confirm('Remove your ' + label.toLowerCase() + '?')) void update(); }}><X size={14} /></button>}
    {(busy || saved || error) && <small className="creator-photo-status" role={error ? 'alert' : 'status'}>
      {error || (busy ? 'Saving ' + label.toLowerCase() + '…' : label + ' updated.')}
    </small>}
  </div>;
}

function VideoTile({ id, caption, likes, images, show }: {
  id: string; caption: string; likes?: number; images?: string[]; show: (id: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  return <button className="creator-tile" title={caption} aria-label={(images?.length ? 'Open photos for ' : 'Play ') + caption} onClick={() => show(id)}>
    {failed ? <Clapperboard aria-hidden="true" /> : <img src={poster(images?.[0] ?? id)} alt="" crossOrigin="anonymous" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    {images?.length ? <span className="creator-photo-count" aria-label={images.length + ' photos'}><Images size={14} />{images.length}</span> : null}
    {likes !== undefined && <span className="creator-tile-count"><Heart size={13} />{count.format(likes)}<span className="sr-only"> likes</span></span>}
  </button>;
}

function UploadTile({ job, retry, dismiss }: { job: UploadJob; retry: () => void; dismiss: () => void }) {
  const [preview, setPreview] = useState('');
  const file = job.file ?? job.photos?.[0];
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const label = job.stage === 'queued' ? 'Queued' : job.stage === 'processing' ? 'Processing' : 'Uploading';
  return <div className="creator-tile creator-upload">
    <Clapperboard aria-hidden="true" />
    {preview && (job.photos?.length ? <img src={preview} alt="" /> : <video src={preview} muted playsInline preload="metadata" aria-hidden="true"
      onLoadedMetadata={event => {
        const player = event.currentTarget;
        if (Number.isFinite(player.duration) && player.duration > 0) player.currentTime = Math.min(0.25, player.duration / 2);
      }} />)}
    <div className="creator-upload-overlay">
      {job.stage === 'failed' ? <>
        <span title={job.error}>Upload failed</span>
        <button type="button" onClick={retry} aria-label={'Retry ' + job.caption}><RotateCcw size={15} /> Retry</button>
        <button type="button" className="creator-upload-dismiss" onClick={dismiss} aria-label={'Dismiss failed upload for ' + job.caption}><X size={16} /></button>
        <small role="alert">{job.error}</small>
      </> : <>
        <div className="creator-progress" data-stage={job.stage} role="progressbar" aria-label={label + ' ' + job.caption}
          aria-valuenow={job.stage === 'uploading' ? job.percent : undefined}>
          <svg viewBox="0 0 44 44" aria-hidden="true">
            <circle cx="22" cy="22" r="18" />
            <circle className="progress-amount" cx="22" cy="22" r="18" pathLength="100"
              strokeDasharray={job.stage === 'uploading' ? `${job.percent} 100` : '28 100'} />
          </svg>
          {job.stage === 'uploading' && <strong aria-hidden="true">{job.percent}%</strong>}
        </div>
        <span>{label}</span>
      </>}
    </div>
  </div>;
}

export default function CreatorProfile({ handle, user, jobs, revision, show, retry, dismiss, forgetPublished, post, account, follow, message, updated }: {
  handle: string; user: Person | null; jobs: UploadJob[]; revision: number; show: (id: string) => void;
  retry: (job: UploadJob) => void; dismiss: (id: string) => void; forgetPublished: (ids: string[]) => void;
  post: () => void; account: () => void; follow: (enabled: boolean) => void; message: () => void; updated: (person: Person) => void;
}) {
  const mine = user?.handle === handle && !!user;
  const [collection, setCollection] = useState<(typeof collections)[number]['title']>('Posts');
  const [extra, setExtra] = useState<Feed>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const refreshProfile = () => setProfileRevision(value => value + 1);
  const result = useData<import('./client').Profile>('/creators/' + encodeURIComponent(handle), revision + profileRevision);
  const profile = result?.data;
  const active = mine ? collection : 'Posts';
  const path = active === 'Saved' ? '/videos/saved?' : active === 'Liked' ? '/videos?galleries=true&liked=true&' : '/videos?galleries=true&creator=' + encodeURIComponent(handle) + '&';
  const page = useData<Feed>(path, revision);
  const clips: Video[] = Array.from(new Map([...(page?.data?.items ?? []), ...(extra?.items ?? [])].map(clip => [clip.id, clip])).values());
  const next = (extra ?? page?.data)?.next;
  const identity = profile ?? (mine ? user : null);
  const currentJobs = mine && active === 'Posts' ? jobs : [];
  const confirmed = page?.data;
  useEffect(() => {
    if (active === 'Posts' && mine && confirmed) forgetPublished(confirmed.items.map(video => video.id));
  }, [active, mine, confirmed, forgetPublished]);

  async function more() {
    if (!next || loading) return;
    setLoading(true);
    setError('');
    try {
      const result = await api<Feed>(path + new URLSearchParams(next));
      setExtra(previous => ({ items: [...(previous?.items ?? []), ...result.items], next: result.next }));
    } catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setError('');
    try {
      const person = await send<Person>('/account/profile', 'PUT', {
        display_name: String(data.get('display_name')).trim(), bio: String(data.get('bio')).trim(),
      });
      updated(person);
      setEditing(false);
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  return <div className="creator-page">
    {identity && <div className="creator-cover" data-custom={!!profile?.cover_id}>
      {profile?.cover_id && <img src={poster(profile.cover_id)} alt="" crossOrigin="anonymous" />}
      {mine && profile && <ProfilePhoto kind="cover" id={profile.cover_id} changed={refreshProfile} />}
    </div>}
    {identity && <div className="creator-intro">
      <div className="creator-identity">
        <div className="creator-avatar-wrap">
          <div className="creator-avatar" aria-hidden="true">
            {profile?.avatar_id ? <img src={poster(profile.avatar_id)} alt="" crossOrigin="anonymous" /> : identity.display_name.slice(0, 1).toUpperCase()}
          </div>
          {mine && profile && <ProfilePhoto kind="avatar" id={profile.avatar_id} changed={refreshProfile} />}
        </div>
        <div><h3>{identity.display_name}</h3><p>@{identity.handle}</p></div>
        {mine && <button className="icon" aria-label="Account settings" onClick={account}><Menu size={21} /></button>}
      </div>
      <dl className="creator-stats">
        <div><dt>Following</dt><dd>{profile ? count.format(profile.following_count) : '–'}</dd></div>
        <div><dt>Followers</dt><dd>{profile ? count.format(profile.followers) : '–'}</dd></div>
        <div><dt>Likes</dt><dd>{profile ? count.format(profile.likes ?? 0) : '–'}</dd></div>
      </dl>
      {profile?.bio && <p className="creator-bio">{profile.bio}</p>}
      <div className="creator-actions">
        {mine ? <>
          <button className="primary" onClick={post}><Plus size={17} /> Create a post</button>
          <button className="secondary" disabled={!profile || editing} onClick={() => { setError(''); setEditing(true); }}><Pencil size={16} /> Edit profile</button>
        </> : profile && <>
          <button className="primary" onClick={() => follow(!profile.following)}>{profile.following ? 'Following' : 'Follow'}</button>
          <button className="secondary" onClick={message}>Message</button>
        </>}
      </div>
      {profile && <ProfileWebsite value={profile.website} owner={mine} changed={refreshProfile} />}
      {editing && <form onSubmit={save}>
        <label>Display name<input name="display_name" defaultValue={identity.display_name} maxLength={48} required /></label>
        <label>Bio<textarea name="bio" defaultValue={profile?.bio} maxLength={160} /></label>
        <div className="creator-actions">
          <button type="submit" className="primary" disabled={saving}>Save profile</button>
          <button type="button" className="secondary" disabled={saving} onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
        </div>
      </form>}
    </div>}
    <nav className="creator-collections" aria-label="Profile collections">
      {(mine ? collections : collections.slice(0, 1)).map(({ title, icon: Icon }) =>
        <button key={title} type="button" aria-pressed={active === title} disabled={loading} onClick={() => {
          if (title === active) return;
          setCollection(title);
          setExtra(undefined);
          setError('');
        }}><Icon size={18} />{title}</button>)}
    </nav>
    <div className="creator-grid">
      {currentJobs.map(job => job.videoId
        ? !clips.some(clip => clip.id === job.videoId) && <VideoTile key={job.id} id={job.videoId} caption={job.caption} images={job.imageIds} show={show} />
        : <UploadTile key={job.id} job={job} retry={() => retry(job)} dismiss={() => dismiss(job.id)} />)}
      {clips.map(clip => <VideoTile key={clip.id} id={clip.id} caption={clip.caption} likes={clip.likes} images={clip.image_ids} show={show} />)}
    </div>
    {(result?.error || page?.error || error) && <p className="creator-message error" role="alert">{result?.error ?? page?.error ?? error}</p>}
    {!page && !currentJobs.length && <p className="creator-message" role="status">Loading videos…</p>}
    {page?.data && !clips.length && !currentJobs.length && <p className="creator-message">
      {active === 'Posts' ? 'No videos posted yet.' : active === 'Saved' ? 'No saved videos yet.' : 'No liked videos yet.'}
    </p>}
    {next && <button className="secondary creator-more" disabled={loading} onClick={() => void more()}>{loading ? 'Loading…' : 'Load more'}</button>}
  </div>;
}
