
'use client';

import {
  ArrowDown, ArrowDownToLine, ArrowUp, Bookmark, Check, ChevronRight, Clapperboard, Coins, Compass,
  Download, Flag, Flame, Heart, House, Inbox as InboxIcon, MapPin, MessageCircle, Plus, Radio, Search, Ticket,
  Send, Share2, Trash2, UploadCloud, UserRound, UsersRound, Volume2, VolumeX, X,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { io } from 'socket.io-client';
import dynamic from 'next/dynamic';
import SignupNameFields from './signup-name-fields';
import InstallApp from './install-app';
import GiftWallet from './gift-wallet';
import LiveInvitePlans from './live-invite-plans';
import Promote, { promotionAction, promotionEvent, usePlacementView, type Placement } from './promote';
import { api, mediaUrl, send, useData, type Comment, type Cursor, type Feed, type Inbox, type Message, type Person, type Profile, type Video } from './client';

type Tab = 'For You' | 'Following' | 'Discover';
type WalletPanel = { kind: 'wallet'; purchaseId?: string; liveCode?: string; liveRoom?:string };
type AccountDestination = 'upload' | 'inbox' | 'account';
type GoogleSignup = { display_name: string };
type GoogleSignIn = { web: boolean; android: boolean };
type GoogleBridge = () => Promise<{ idToken?: string; cancelled?: boolean }>;
type GoogleWindow = Window & { mwituAndroidGoogle?: GoogleBridge };
type Panel =
  | { kind: 'upload' | 'inbox' | 'account' | 'saved' | 'invites' }
  | { kind: 'auth'; liveCode?: string; wallet?: WalletPanel; destination?: AccountDestination }
  | { kind: 'googleSignup'; signup: GoogleSignup; next?: Panel }
  | WalletPanel
  | { kind: 'live'; code?: string; resume?: boolean; roomId?:string }
  | { kind: 'promote'; videoId?:string }
  | { kind: 'comments' | 'report'; video: Video }
  | { kind: 'profile' | 'chat'; handle: string };

const Live = dynamic(() => import('./live'), { ssr: false });

function Avatar({ name }: { name: string }) {
  return <span className="avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

function Dialog({ title, kind, close, children }: { title: string; kind: Panel['kind']; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} data-panel={kind} aria-label={title} onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
    if (event.target === ref.current) close();
  }}>
    <section className="dialog-inner">
      <header><h2>{title}</h2><button className="icon" onClick={close} aria-label="Close"><X size={21} /></button></header>
      {children}
    </section>
  </dialog>;
}

function Action({ icon, label, onClick, active }: {
  icon: ReactNode; label: string; onClick: () => void; active?: boolean;
}) {
  return <button className={'action' + (active ? ' active' : '')} onClick={onClick} aria-label={label} aria-pressed={active} title={label}>
    <span aria-hidden="true">{icon}</span>
  </button>;
}

function SavedVideos({ show }: { show: (id: string) => void }) {
  const [pages, setPages] = useState<Cursor[]>([]);
  const cursor = pages.at(-1);
  const saved = useData<Feed>('/videos/saved' + (cursor ? '?' + new URLSearchParams(cursor) : ''));
  const next = saved?.data?.next;
  return <>
    <div className="list">
      {saved?.data?.items.map(video => <button className="row item" key={video.id} onClick={() => show(video.id)}>
        <Bookmark size={20} /><div><strong>{video.caption}</strong><p>@{video.handle}</p></div><ChevronRight size={18} />
      </button>)}
      <p className="hint">{saved?.error ?? (!saved ? 'Loading saved videos…' : !saved.data?.items.length ? 'No saved videos on this page.' : '')}</p>
    </div>
    {(pages.length > 0 || next) && <div className="profile-actions">
      {pages.length > 0 && <button className="secondary" onClick={() => setPages(current => current.slice(0, -1))}>Previous</button>}
      {next && <button className="secondary" onClick={() => setPages(current => [...current, next])}>Next</button>}
    </div>}
  </>;
}

function Clip({ video, root, muted, onMute, children, profile, manage, promotion, goalAction }: {
  video: Video; root: HTMLElement | null; muted: boolean; onMute: () => void; children: ReactNode; profile: () => void; manage: ReactNode;
  promotion?:Placement; goalAction:()=>void;
}) {
  const section = useRef<HTMLElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [adRef,setAdRef]=useState<HTMLElement|null>(null);
  usePlacementView(adRef,promotion);
  useEffect(() => {
    const element = section.current;
    const media = player.current;
    if (!element || !media || !root) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void media.play().catch(() => undefined);
      else media.pause();
    }, { root, threshold: .7 });
    observer.observe(element);
    return () => { observer.disconnect(); media.pause(); };
  }, [root]);
  return <article className="clip" ref={section} data-clip={video.id}>
    <div className="clip-frame">
      <div className="stage">
        <video ref={player} src={mediaUrl(video.id)} loop muted={muted} playsInline preload="none"
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setFailed(true)} />
        <button className="play-area" aria-label={playing ? 'Pause video' : 'Play video'} onClick={() => {
          const media = player.current;
          if (media?.paused) void media.play().catch(() => setFailed(true));
          else media?.pause();
        }}>{failed ? 'Video unavailable' : !playing && <span>▶</span>}</button>
        <div className="clip-top">
          <button aria-label={muted ? 'Unmute' : 'Mute'} className="icon" onClick={onMute}>
            {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
          </button>
        </div>
        <div className="actions" role="group" aria-label="Video actions">{children}</div>
      </div>
      <div className="clip-info">
        <div className="clip-byline">
          <button onClick={profile}><Avatar name={video.display_name} /><span>{video.display_name} <small>@{video.handle}</small></span></button>
          {manage}
        </div>
        {video.caption && <p>{video.caption}</p>}
        {promotion&&<div ref={setAdRef} className="commerce-heading promoted-cta">
          <small>Sponsored</small>
          {promotion.destination ? <a className="secondary" href={promotion.destination} target="_blank" rel="noopener noreferrer sponsored"
            onClick={()=>void promotionEvent(promotion,'click')}>{promotionAction(promotion)}</a>
            : <button className="secondary" onClick={()=>{void promotionEvent(promotion,'click');if(promotion.goal==='views')void player.current?.play().catch(()=>undefined);else goalAction();}}>{promotionAction(promotion)}</button>}
        </div>}
      </div>
    </div>
  </article>;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>('For You');
  const [user, setUser] = useState<Person | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [shared, setShared] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [muted, setMuted] = useState(true);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [extra, setExtra] = useState<Feed | null>(null);
  const [feedRev, setFeedRev] = useState(0);
  const [inboxRev, setInboxRev] = useState(0);
  const [unread, setUnread] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [pending, setPending] = useState(false);
  const [google, setGoogle] = useState<'web' | 'android' | null>(null);
  const [nativeApp, setNativeApp] = useState(false);
  const [fileName, setFileName] = useState('');
  const [mutation, setMutation] = useState(false);
  const paneKind = useRef<string | undefined>(undefined);
  paneKind.current = panel?.kind;

  const refresh = () => setFeedRev(value => value + 1);
  const refreshInbox = () => setInboxRev(value => value + 1);
  useEffect(() => {
    const app = /MwituFlutter\//.test(navigator.userAgent);
    setNativeApp(app);
    const params = new URLSearchParams(window.location.search);
    const id = params.get('v');
    const videoId = id && /^[a-f0-9-]{36}$/i.test(id) ? id : undefined;
    if (videoId) setShared(videoId);
    const destination = params.get('browse');
    const googleStatus = params.get('google');
    if (destination === 'videos') setTab('Discover');
    const liveCode = params.get('live');
    const topup = params.get('topup');
    const liveRoom=params.get('room')??'';
    if (topup && /^[a-f0-9-]{36}$/i.test(topup)) {
      setPanel({ kind: 'wallet', purchaseId: topup, liveCode: liveCode && /^(?:\d{6}|[a-f0-9]{16})$/i.test(liveCode) ? liveCode : undefined,
        liveRoom:/^[a-f0-9-]{36}$/i.test(liveRoom)?liveRoom:undefined });
    } else if (liveCode || destination === 'live') {
      setPanel({ kind: 'live', code: liveCode?.slice(0, 32),
        resume: googleStatus === 'signed-in' || googleStatus === 'choose-handle' });
    } else if (destination === 'wallet') {
      setPanel({ kind: 'wallet' });
    }
    if (!topup && !liveCode && videoId && params.get('action') === 'comments') {
      api<Video>('/videos/' + videoId).then(video => {
        setPanel(current => current ?? { kind: 'comments', video });
      }).catch(() => undefined);
    }
    api<{ user: Person | null; google?: GoogleSignIn; googleSignup?: GoogleSignup }>('/auth/me').then(result => {
      setUser(result.user);
      if (app && (window as GoogleWindow).mwituAndroidGoogle && result.google?.android) setGoogle('android');
      if (!app && result.google?.web) setGoogle('web');
      if (googleStatus) {
        const clean = new URL(window.location.href);
        clean.searchParams.delete('google');
        window.history.replaceState(null, '', clean);
      }
      const target = destination === 'post' ? 'upload' : destination;
      const account = target === 'upload' || target === 'inbox' || target === 'account' ? target : undefined;
      const signup = result.googleSignup;
      if (signup && (googleStatus === 'choose-handle' || (!googleStatus && !result.user))) {
        setPanel(current => ({ kind: 'googleSignup', signup,
          next: current ?? (account ? { kind: account } : undefined) }));
        return;
      }
      if (googleStatus === 'error' || googleStatus === 'choose-handle') {
        setFeedback('Google sign-in could not finish. Please try again.');
      }
      if (!topup && !liveCode && !videoId) {
        if (account) {
          setPanel(current => current ?? (result.user ? { kind: account } : { kind: 'auth', destination: account }));
        }
      }
    }).catch(() => undefined).finally(() => setSessionReady(true));
  }, []);

  useEffect(() => {
    const localSocket = process.env.NEXT_PUBLIC_REALTIME_URL ?? process.env.NEXT_PUBLIC_API_ORIGIN
      ?? (process.env.NODE_ENV === 'development' ? 'http://localhost:4000' : undefined);
    const socket = io(localSocket, { transports: ['websocket'], withCredentials: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    socket.on('feed:changed', () => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; setFeedRev(value => value + 1); }, 250);
    });
    socket.on('connect', () => {
      setFeedRev(value => value + 1);
      setInboxRev(value => value + 1);
    });
    socket.on('inbox:changed', () => {
      setInboxRev(value => value + 1);
      if (paneKind.current !== 'inbox' && paneKind.current !== 'chat') setUnread(true);
    });
    return () => { clearTimeout(timer); socket.disconnect(); };
  }, [user?.id]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 4200);
    return () => clearTimeout(timer);
  }, [feedback]);

  const filters = new URLSearchParams();
  if (tab === 'Following') filters.set('following', 'true');
  if (tab === 'Discover' && query) filters.set('q', query);
  const feedPath = '/videos?' + filters.toString();
  const feed = useData<Feed>(feedPath, feedRev);
  const placementResult=useData<Placement|null>(sessionReady&&tab==='For You'&&!shared?'/promote/placement?surface=feed':null);
  const placement=placementResult?.data;
  const promotedVideo=useData<Video>(placement?.videoId?'/videos/'+placement.videoId:null,feedRev);
  const linked = useData<Video>(shared ? '/videos/' + shared : null, feedRev);
  const comments = useData<Comment[]>(panel?.kind === 'comments' ? '/videos/' + panel.video.id + '/comments' : null, feedRev);
  const creator = useData<Profile>(panel?.kind === 'profile' ? '/creators/' + panel.handle : null, feedRev);
  const creatorVideos = useData<Feed>(panel?.kind === 'profile' ? '/videos?creator=' + panel.handle : null, feedRev);
  const inbox = useData<Inbox[]>(panel?.kind === 'inbox' && user ? '/inbox' : null, inboxRev);
  const messages = useData<Message[]>(panel?.kind === 'chat' && user ? '/inbox/' + panel.handle : null, inboxRev);
  const organic = shared
    ? (linked?.data ? [linked.data] : [])
    : [...new Map([...(feed?.data?.items ?? []), ...(extra?.items ?? [])]
      .reverse().map(video => [video.id, video])).values()].reverse();
  const paid=promotedVideo?.data;
  const baseClips=paid?organic.filter(video=>video.id!==paid.id):organic;
  const clips=paid?[...baseClips.slice(0,1),paid,...baseClips.slice(1)]:baseClips;

  function open(next: Panel) {
    setDialogError('');
    setFileName('');
    if (next.kind === 'inbox' || next.kind === 'chat') setUnread(false);
    setPanel(next);
  }

  function protectedPanel(next: Panel) {
    open(user ? next : { kind: 'auth' });
  }

  function clearLink() {
    setShared('');
    window.history.replaceState(null, '', window.location.pathname);
  }

  function clearCheckout() {
    const url = new URL(window.location.href);
    for (const key of ['topup', 'reference', 'trxref', 'live','room']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url);
  }

  function choose(next: Tab) {
    clearLink();
    setExtra(null);
    setTab(next);
    root?.scrollTo(0, 0);
  }

  function showVideo(id: string) {
    setShared(id);
    window.history.replaceState(null, '', '?v=' + id);
    root?.scrollTo(0, 0);
    setPanel(null);
  }

  async function more() {
    const cursor = (extra ?? feed?.data)?.next;
    if (!cursor || mutation) return;
    setMutation(true);
    try {
      const page = await api<Feed>(feedPath + '&' + new URLSearchParams(cursor));
      setExtra(old => ({ items: [...(old?.items ?? []), ...page.items], next: page.next }));
    } catch (error) { setFeedback((error as Error).message); }
    finally { setMutation(false); }
  }

  async function change(path: string, method: string, body?: object, update?: (video: Video) => Video) {
    if (!user) { open({ kind: 'auth' }); return; }
    if (mutation) return;
    setMutation(true);
    try {
      await send(path, method, body);
      if (method === 'DELETE') { clearLink(); setExtra(null); }
      if (update) setExtra(old => old && { ...old, items: old.items.map(update) });
      refresh();
    } catch (error) { setFeedback((error as Error).message); }
    finally { setMutation(false); }
  }

  async function signInWithGoogle(auth: Extract<Panel, { kind: 'auth' }>) {
    if (!google || pending) return;
    setPending(true);
    setDialogError('');
    const next: Panel | undefined = auth.wallet ?? (auth.liveCode ? { kind: 'live', code: auth.liveCode, resume: true }
      : auth.destination ? { kind: auth.destination } : undefined);
    try {
      if (google === 'web') {
        const params = new URLSearchParams(window.location.search);
        if (auth.liveCode) params.set('live', auth.liveCode);
        if (auth.wallet && !auth.wallet.purchaseId) params.set('browse', 'wallet');
        if (auth.destination) params.set('browse', auth.destination === 'upload' ? 'post' : auth.destination);
        const { url } = await send<{ url: string }>('/auth/google/start', 'POST', { next: params.toString() });
        window.location.assign(url);
        return;
      }
      const result = await (window as GoogleWindow).mwituAndroidGoogle?.();
      if (result?.cancelled) return;
      if (!result?.idToken) throw new Error('Google sign-in could not finish. Please try again.');
      const signedIn = await send<{ user?: Person; googleSignup?: GoogleSignup }>('/auth/google/android', 'POST', { idToken: result.idToken });
      if (signedIn.googleSignup) {
        setPanel({ kind: 'googleSignup', signup: signedIn.googleSignup, next });
      } else if (signedIn.user) {
        setUser(signedIn.user);
        setExtra(null);
        setPanel(next ?? null);
        refresh();
      }
    } catch (error) {
      setDialogError((error as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!panel || pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setDialogError('');
    setPending(true);
    try {
      switch (panel.kind) {
        case 'auth': {
          const person = await send<Person>('/auth/' + mode, 'POST', Object.fromEntries(data));
          setUser(person);
          setExtra(null);
          setPanel(panel.wallet ?? (panel.liveCode ? { kind: 'live', code: panel.liveCode, resume: true }
            : panel.destination ? { kind: panel.destination } : null));
          refresh();
          break;
        }
        case 'googleSignup': {
          const person = await send<Person>('/auth/google/complete', 'POST', Object.fromEntries(data));
          setUser(person);
          setExtra(null);
          setPanel(panel.next ?? null);
          refresh();
          break;
        }
        case 'upload': {
          const result = await api<{ id: string }>('/videos', { method: 'POST', body: data });
          showVideo(result.id);
          setFeedback('Video published.');
          refresh();
          break;
        }
        case 'comments':
          await send('/videos/' + panel.video.id + '/comments', 'POST', { body: data.get('body') });
          form.reset();
          refresh();
          break;
        case 'chat':
          await send('/inbox/' + panel.handle, 'POST', { body: data.get('body') });
          form.reset();
          refreshInbox();
          break;
        case 'report':
          await send('/videos/' + panel.video.id + '/report', 'POST', { reason: data.get('body') });
          setPanel(null);
          setFeedback('Report submitted.');
          break;
      }
    } catch (error) { setDialogError((error as Error).message); }
    finally { setPending(false); }
  }

  async function share(id: string) {
    const url = new URL(location.hostname === 'tiktokmwitu.co.ke' ? '/watch/' + id : '?v=' + id, location.origin).href;
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Watch on TikTok Mwitu', url });
        return;
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setFeedback('Video link copied.');
    } catch { setFeedback('Copy the video URL from your address bar.'); showVideo(id); }
  }

  function step(direction: number) {
    if (!root) return;
    const nodes = [...root.querySelectorAll<HTMLElement>('[data-clip]')];
    const index = nodes.findIndex(node => Math.abs(node.getBoundingClientRect().top - root.getBoundingClientRect().top) < 8);
    const target = nodes[index + direction];
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (direction > 0 && !shared) void more();
  }

  async function logout() {
    try {
      await send('/auth/logout', 'POST');
      setUser(null);
      setUnread(false);
      setExtra(null);
      setPanel(null);
      refresh();
    } catch (error) { setDialogError((error as Error).message); }
  }

  const titles = {
    auth: mode === 'register' ? 'Join Tiktok mwitu' : 'Welcome back',
    googleSignup: 'Choose your handle',
    upload: 'Post a video', comments: 'Comments', profile: 'Creator profile',
    inbox: 'Inbox', chat: panel && 'handle' in panel ? '@' + panel.handle : 'Chat',
    report: 'Report video', account: 'Your account', live: 'Live broadcasts', saved: 'Saved videos', wallet: 'Coin wallet', invites:'LIVE invite plans',promote:'Promote',
  };
  const feedError = shared ? linked?.error : feed?.error;
  const ready = shared ? !!linked : !!feed;
  const navigation = [
    { name: 'For You' as const, icon: House },
    { name: 'Following' as const, icon: UsersRound },
    { name: 'Discover' as const, icon: Compass },
  ];

  return <div className="shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => choose('For You')} aria-label="Tiktok mwitu home">
        <span className="brand-icon"><img src="/icons/mwitu-192.png" alt="" width="40" height="40" /></span>
        <span>Tiktok <strong>mwitu</strong></span>
      </button>
      <nav aria-label="Main menu">
        {navigation.map(({ name, icon: Icon }) => <button key={name} aria-label={name} className={tab === name && !shared ? 'selected' : ''}
          aria-current={tab === name && !shared ? 'page' : undefined} onClick={() => choose(name)}><Icon size={21} /> <span>{name}</span></button>)}
        <button aria-label="Inbox" onClick={() => protectedPanel({ kind: 'inbox' })}><InboxIcon size={21} /><span>Inbox</span>{unread && <i className="unread" />}</button>
        <button aria-label="Live broadcasts" onClick={() => open({ kind: 'live' })}><Radio size={21} /><span>Live</span></button>
      </nav>
        <a className="catalog-link" href="/videos">Browse Kenyan videos</a>
        <a className="catalog-link" href="/download">Get the Android app</a>
      <button className="primary post" aria-label="Post a video" onClick={() => protectedPanel({ kind: 'upload' })}><Plus size={22} /> <span>Post a video</span></button>
      <button className="account" aria-label={user ? 'Your account' : 'Log in / Sign up'} onClick={() => open({ kind: user ? 'account' : 'auth' })}>
        {user ? <Avatar name={user.display_name} /> : <UserRound size={19} />} <span>{user ? '@' + user.handle : 'Log in / Sign up'}</span>
      </button>
    </aside>

    <main className="workspace">
      <header className="top">
        <button className="mobile-brand" onClick={() => choose('For You')} aria-label="Home"><img src="/icons/mwitu-192.png" alt="" width="34" height="34" /></button>
        <div className="top-tabs" aria-label="Feed">
          {navigation.map(({ name }) => <button className={tab === name && !shared ? 'current' : ''} key={name} onClick={() => choose(name)}>{name}</button>)}
        </div>
        <div className="top-tools">
          <InstallApp interrupted={!!panel} />
          <button className="top-account icon" onClick={() => open({ kind: user ? 'account' : 'auth' })} aria-label="Account"><UserRound size={19} /></button>
        </div>
      </header>
      {tab === 'Discover' && !shared && <form className="search" onSubmit={event => {
        event.preventDefault(); setExtra(null); setQuery(search.trim()); root?.scrollTo(0, 0);
      }}>
        <Search size={20} />
        <input aria-label="Search videos" placeholder="Search creators or captions" value={search} onChange={event => setSearch(event.target.value)} maxLength={80} />
        <button className="secondary">Search</button>
      </form>}
      <div className="content">
        <div className="stream" ref={setRoot} tabIndex={0} aria-label="Video feed" onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); step(event.key === 'ArrowDown' ? 1 : -1);
          }
        }}>
          {clips.map(video => <Clip key={video.id} video={video} root={root} muted={muted} onMute={() => setMuted(!muted)}
            profile={() => open({ kind: 'profile', handle: video.handle })}
            promotion={video.id===paid?.id?placement??undefined:undefined}
            goalAction={()=>open(placement?.goal==='engagement'?{kind:'comments',video}:{kind:'profile',handle:video.handle})}
            manage={<div className="clip-utilities">
              {user?.id===video.creator_id&&<button className="icon" aria-label="Promote video" title="Promote video"
                onClick={()=>open({kind:'promote',videoId:video.id})}><Flame size={18}/></button>}
              <button className="icon" aria-label="Share" title="Share" onClick={() => void share(video.id)}><Share2 size={18} /></button>
              {user?.id === video.creator_id
                ? <button className="icon" aria-label="Delete video" onClick={() => {
                  if (confirm('Permanently delete this video?')) void change('/videos/' + video.id, 'DELETE');
                }}><Trash2 size={17} /></button>
                : <button className="icon" aria-label="Report video" onClick={() => protectedPanel({ kind: 'report', video })}><Flag size={17} /></button>}
            </div>}>
            {user?.id === video.creator_id
              ? <Action icon={<UserRound size={21} />} label="Profile" onClick={() => open({ kind: 'profile', handle: video.handle })} />
              : <Action icon={video.following ? <Check size={21} /> : <Plus size={22} />} label={video.following ? 'Following' : 'Follow'}
                active={video.following} onClick={() => change('/creators/' + video.handle + '/follow', 'PUT', { enabled: !video.following },
                  item => item.creator_id === video.creator_id ? { ...item, following: !video.following } : item)} />}
            <Action icon={<Heart size={22} fill={video.liked ? 'currentColor' : 'none'} />} label={video.liked ? 'Unlike' : 'Like'}
              active={video.liked} onClick={() => change('/videos/' + video.id + '/like', 'PUT', { enabled: !video.liked },
                item => item.id === video.id ? { ...item, liked: !video.liked, likes: Math.max(0, item.likes + (video.liked ? -1 : 1)) } : item)} />
            <Action icon={<MessageCircle size={22} />} label="Comments" onClick={() => open({ kind: 'comments', video })} />
            <a className="action" href={mediaUrl(video.id) + '?download=1'} download aria-label="Save video" title="Save video">
              <span aria-hidden="true"><ArrowDownToLine size={21} /></span>
            </a>
            <Action icon={<Bookmark size={21} fill={video.saved ? 'currentColor' : 'none'} />} label={video.saved ? 'Remove bookmark' : 'Bookmark'}
              active={video.saved} onClick={() => change('/videos/' + video.id + '/save', 'PUT', { enabled: !video.saved },
                item => item.id === video.id ? { ...item, saved: !video.saved } : item)} />
          </Clip>)}
          {!clips.length && <div className="empty">
            <div className="empty-art" aria-hidden="true"><div className="art-inner"><img src="/icons/mwitu-192.png" alt="" width="64" height="64" /></div></div>
            <div>
              <h1>{feedError ? 'Feed unavailable' : !ready ? 'Kenyan short videos' : tab === 'Following' ? 'Your following feed' : query ? 'No matching videos' : 'What’s happening mtaani?'}</h1>
              <p>{feedError ?? (!ready ? 'Watch clips from Kenyan creators or explore LIVE streams.' : tab === 'Following' ? 'Follow Kenyan creators to see their latest posts here.' : query ? 'Try a different creator or caption.' : 'Share a short video from your corner of Kenya.')}</p>
              {!ready && <p><a className="catalog-link" href="/videos">Browse videos</a> · <a className="catalog-link" href="/live">Explore LIVE</a></p>}
              {feedError ? <button className="secondary" onClick={refresh}>Try again</button> : ready && (tab === 'Following'
                ? <button className="secondary" onClick={() => choose('For You')}>Browse For You</button>
                : !query && <button className="primary" onClick={() => protectedPanel({ kind: 'upload' })}><Plus size={19} /> Post a video</button>)}
            </div>
          </div>}
          {!shared && (extra ?? feed?.data)?.next && <div className="load"><button className="secondary" disabled={mutation} onClick={() => void more()}><ArrowDownToLine size={16} /> Load more</button></div>}
        </div>
        <div className="side-controls" aria-label="Browse videos">
          <aside className="discovery-rail" aria-label="Discover Mwitu">
            <div className="discovery-live">
              <span><MapPin size={14} /> Kenya</span>
              <div>
                <h2>LIVE in the mtaa</h2>
                <button className="primary" onClick={() => open({ kind: 'live' })}><Radio size={18} /> Browse LIVE</button>
              </div>
            </div>
            <button className="discovery-search" onClick={() => choose('Discover')}><Search size={18} /> Find creators and clips</button>
          </aside>
          {!!clips.length && <div><button className="icon" aria-label="Previous video" onClick={() => step(-1)}><ArrowUp size={20} /></button>
            <button className="icon" aria-label="Next video" onClick={() => step(1)}><ArrowDown size={20} /></button></div>}
        </div>
      </div>
      <nav className="mobile-nav" aria-label="Mobile menu">
        {navigation.map(({ name, icon: Icon }) => <button key={name} className={tab === name && !shared ? 'selected' : ''} onClick={() => choose(name)}><Icon size={20} />{name}</button>)}
        <button className="mobile-post" onClick={() => protectedPanel({ kind: 'upload' })}><Plus size={23} />Post</button>
        <button onClick={() => protectedPanel({ kind: 'inbox' })}><InboxIcon size={20} />Inbox{unread && <i className="unread" />}</button>
        <button onClick={() => open({ kind: 'live' })}><Radio size={20} />Live</button>
      </nav>
    </main>

    {panel && <Dialog key={panel.kind} kind={panel.kind} title={titles[panel.kind]} close={() => {
      if (pending) return;
      if (panel.kind === 'auth' && panel.wallet) { open(panel.wallet); return; }
      if (panel.kind === 'auth' && panel.liveCode) { open({ kind: 'live', code: panel.liveCode }); return; }
      if (panel.kind === 'wallet' && panel.purchaseId) clearCheckout();
      if (panel.kind === 'live') {
        const url = new URL(window.location.href);
        url.searchParams.delete('live');
        url.searchParams.delete('browse');
        window.history.replaceState(null, '', url);
      }
      setPanel(null);
    }}>
      {panel.kind === 'live' && <Live user={user} sessionReady={sessionReady} initialCode={panel.code} resume={panel.resume} roomId={panel.roomId}
        signIn={liveCode => open({ kind: 'auth', liveCode })} />}
      {panel.kind === 'auth' && <form onSubmit={submit}>
        {panel.liveCode && <p className="hint">After signing in, you’ll return to the LIVE.</p>}
        {google && <button type="button" className="secondary" disabled={pending}
          onClick={() => void signInWithGoogle(panel)}>Continue with Google</button>}
        {mode === 'register' ? <SignupNameFields /> : <label>Handle<input name="handle" autoComplete="username"
          pattern="[A-Za-z0-9_]{3,24}" maxLength={24} required /></label>}
        <label>Password<input name="password" type="password" minLength={10} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required /></label>
        <button className="primary" disabled={pending}>{mode === 'register' ? 'Create account' : 'Log in'}</button>
        <button type="button" className="link" disabled={pending} onClick={() => { setDialogError(''); setMode(mode === 'register' ? 'login' : 'register'); }}>
          {mode === 'register' ? 'Already have an account? Log in' : 'Create an account'}
        </button>
      </form>}
      {panel.kind === 'googleSignup' && <form onSubmit={submit}>
        <SignupNameFields initialDisplayName={panel.signup.display_name} />
        <button className="primary" disabled={pending}>Finish creating account</button>
      </form>}
      {panel.kind === 'upload' && <form onSubmit={submit}>
        <label className="drop">
          <input className="upload-input" aria-label="Choose a Video." type="file" name="video" accept=".mp4,.mov,.webm,video/mp4,video/webm,video/quicktime" required onChange={event => {
            const file = event.target.files?.[0];
            event.target.setCustomValidity(file && file.size > 48 * 1024 * 1024 ? 'Choose a video under 48 MB.' : '');
            setFileName(file?.name ?? '');
          }} />
          <span className="upload-picker"><UploadCloud size={24} /> Choose a Video.</span>
          {fileName && <span className="upload-file">{fileName}</span>}
          <small>MP4, MOV or WebM · 48 MB · First 60 seconds</small>
        </label>
        <label>Caption<textarea name="caption" maxLength={500} required placeholder="What should people know?" /></label>
        <button className="secondary" disabled={pending}>{pending ? 'Uploading and processing…' : 'Publish video'}</button>
      </form>}
      {panel.kind === 'comments' && <>
        <div className="list">
          {comments?.data?.map(comment => <div className="row" key={comment.id}><Avatar name={comment.handle} /><div><strong>@{comment.handle}</strong><p>{comment.body}</p></div></div>)}
          <p className="hint">{comments?.error ?? (comments?.data?.length === 0 ? 'Start the conversation.' : '')}</p>
        </div>
        {user ? <form className="inline" onSubmit={submit}><input name="body" aria-label="Comment" placeholder="Write a comment…" required maxLength={500} />
          <button className="primary" disabled={pending} aria-label="Send comment"><Send size={18} /></button></form>
          : <button className="primary" onClick={() => open({ kind: 'auth' })}>Log in to comment</button>}
      </>}
      {panel.kind === 'profile' && <>
        {creator?.data && <div className="profile">
          <Avatar name={creator.data.display_name} /><h3>{creator.data.display_name}</h3><p>@{creator.data.handle}</p>
          <div className="stats"><span>{creator.data.followers} followers</span><span>{creator.data.following_count} following</span></div>
          {user?.id !== creator.data.id && <div className="profile-actions">
            <button className="primary" onClick={() => change('/creators/' + panel.handle + '/follow', 'PUT', { enabled: !creator.data?.following })}>
              {creator.data.following ? 'Unfollow' : 'Follow'}
            </button>
            <button className="secondary" onClick={() => protectedPanel({ kind: 'chat', handle: panel.handle })}>Message</button>
          </div>}
        </div>}
        <div className="list">
          {creatorVideos?.data?.items.map(video => <button className="row item" key={video.id} onClick={() => showVideo(video.id)}>
            <Clapperboard size={21} /><div>{video.caption}</div><ChevronRight size={18} /></button>)}
          <p className="hint">{creator?.error ?? creatorVideos?.error ?? (creatorVideos?.data?.items.length === 0 ? 'No videos yet.' : '')}</p>
        </div>
      </>}
      {panel.kind === 'inbox' && <div className="list">
        {inbox?.data?.map(entry => <button className="row item" key={entry.handle} onClick={() => open({ kind: 'chat', handle: entry.handle })}>
          <Avatar name={entry.display_name} /><div><strong>{entry.display_name}</strong><p>{entry.body}</p></div><ChevronRight size={18} />
        </button>)}
        <p className="hint">{inbox?.error ?? (inbox?.data?.length === 0 ? 'Open a creator’s profile to send a message.' : '')}</p>
      </div>}
      {panel.kind === 'chat' && <>
        <button className="link" onClick={() => open({ kind: 'inbox' })}>Back to Inbox</button>
        <div className="list messages">
          {messages?.data?.map(message => <p className={message.mine ? 'bubble mine' : 'bubble'} key={message.id}>{message.body}</p>)}
          <p className="hint">{messages?.error ?? (messages?.data?.length === 0 ? 'Say hello.' : '')}</p>
        </div>
        <form className="inline" onSubmit={submit}><input name="body" aria-label="Message" placeholder="Write a message…" maxLength={1000} required />
          <button className="primary" disabled={pending} aria-label="Send message"><Send size={18} /></button></form>
      </>}
      {panel.kind === 'report' && <form onSubmit={submit}>
        <label>What should we review?<textarea name="body" maxLength={500} required /></label>
        <button className="primary" disabled={pending}>Submit report</button>
      </form>}
      {panel.kind === 'account' && user && <div className="profile account-panel">
        <Avatar name={user.display_name} /><h3>{user.display_name}</h3><p>@{user.handle}</p>
        <div className="profile-actions">
          <button className="primary" onClick={() => open({ kind: 'profile', handle: user.handle })}>View profile</button>
          <button className="secondary" onClick={() => void logout()}>Log out</button>
        </div>
        <div className="account-links">
          {!nativeApp && <a className="secondary account-download" href="/download">
            <Download size={19} aria-hidden="true" /> Get the Android app
          </a>}
          <button className="secondary" onClick={() => open({ kind: 'saved' })}><Bookmark size={19} /> Saved videos</button>
          <button className="secondary" onClick={() => open({ kind: 'wallet' })}><Coins size={19} /> Coin wallet</button>
          <button className="secondary" onClick={() => open({ kind: 'invites' })}><Ticket size={19} /> LIVE invite plans</button>
          <button className="secondary" onClick={() => open({ kind: 'promote' })}><Flame size={19} /> Promote</button>
        </div>
      </div>}
      {panel.kind === 'wallet' && <>
        {!sessionReady ? <p role="status">Opening your wallet…</p>
          : user ? <GiftWallet purchaseId={panel.purchaseId} liveCode={panel.liveCode} liveRoom={panel.liveRoom} /> : <button className="primary" onClick={() => {
          setMode('login');
          open({ kind: 'auth', wallet: panel });
        }}>Sign in to view wallet</button>}
        {(panel.liveCode||panel.liveRoom) && user && <button className="link" onClick={() => {
          clearCheckout();
          open({ kind: 'live', code: panel.liveCode, roomId:panel.liveRoom, resume: true });
        }}>Return to LIVE</button>}
      </>}
      {panel.kind==='invites'&&user&&<LiveInvitePlans/>}
      {panel.kind==='promote'&&user&&<Promote videoId={panel.videoId}/>}
      {panel.kind === 'saved' && user && <SavedVideos show={showVideo} />}
      {dialogError && <p className="error" role="alert">{dialogError}</p>}
    </Dialog>}
    {feedback && <div className="toast" role="status">{feedback}</div>}
  </div>;
}
