const origin = 'https://tiktokmwitu.co.ke';
const apiOrigin = 'https://api.tiktokmwitu.co.ke';
const brand = 'TikTok Mwitu';
const brandImage = origin + '/icons/mwitu-512.png';
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const videoId = new RegExp('^' + uuid + '$', 'i');
const watchRoute = new RegExp('^/watch/(' + uuid + ')/?$', 'i');
const creatorRoute = /^\/creators\/([a-z0-9_]{3,24})\/?$/i;
const shardRoute = /^\/sitemap-videos-([1-9]\d{0,4})\.xml$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ssrHeaders = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };

function escape(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[&<>"']/g, char => entities[char]);
}

function excerpt(value, length) {
  const chars = Array.from(value.replace(/\s+/g, ' ').trim());
  return chars.length > length ? chars.slice(0, length - 1).join('').trimEnd() + '…' : chars.join('');
}

const watchPath = id => '/watch/' + id;
const creatorPath = handle => '/creators/' + handle;
const mediaUrl = (id, extension) => origin + '/media/' + id + '.' + extension;

function respond(body, head, type, status = 200) {
  const headers = { ...ssrHeaders, 'Content-Type': type + '; charset=utf-8' };
  if (status === 404) headers['X-Robots-Tag'] = 'noindex';
  if (status === 503) {
    headers['Cache-Control'] = 'no-store';
    headers['Retry-After'] = '60';
  }
  return new Response(head ? null : body, { status, headers });
}

function page(head, { title, description, path, content, image = brandImage, imageAlt = brand + ' app icon', schema,
  video = false, status = 200 }) {
  const canonical = path ? origin + path : null;
  const meta = (name, value) => '<meta name="' + name + '" content="' + escape(value) + '">';
  const og = (name, value) => '<meta property="og:' + name + '" content="' + escape(value) + '">';
  const markup = schema ? '<script type="application/ld+json">' + JSON.stringify(schema).replace(/</g, '\\u003c') + '</script>' : '';
  return respond('<!doctype html><html lang="en-KE"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#15121b">' +
    '<title>' + escape(title) + '</title>' + meta('description', description) +
    (canonical ? '<link rel="canonical" href="' + escape(canonical) + '">' +
      meta('robots', 'index, follow, max-image-preview:large, max-video-preview:-1') +
      og('title', title) + og('description', description) + og('url', canonical) + og('site_name', brand) +
      og('locale', 'en_KE') + og('type', video ? 'video.other' : 'website') + og('image', image) + og('image:alt', imageAlt) +
      meta('twitter:card', 'summary') + meta('twitter:title', title) + meta('twitter:description', description) +
      meta('twitter:image', image) + meta('twitter:image:alt', imageAlt) : '') +
    '<link rel="icon" href="/icons/mwitu-note.svg" type="image/svg+xml"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/discovery.css">' + markup +
    '</head><body><header class="site-header"><a class="brand" href="/"><img width="36" height="36" src="/icons/mwitu-192.png" alt=""><span class="mwitu-wordmark">TikTok <strong>Mwitu</strong></span>' +
    '</a><nav aria-label="Explore"><a href="/videos">Videos</a><a href="/live">LIVE</a></nav></header>' +
    '<main>' + content + '</main></body></html>', head, 'text/html', status);
}

async function api(path) {
  const response = await fetch(apiOrigin + '/api' + path, {
    headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(7000),
  });
  if (response.status === 404 && path.startsWith('/videos/')) return null;
  if (!response.ok) throw new Error('Discovery API returned ' + response.status);
  return response.json();
}

function failure(head, status = 404) {
  const heading = status === 404 ? 'Page unavailable' : 'Please try again in a moment';
  return page(head, { status, title: heading + ' | ' + brand, description: heading,
    content: '<h1>' + heading + '</h1><p><a href="/">Return to TikTok Mwitu</a></p>' });
}

async function watch(head, id) {
  const clip = await api('/videos/' + id);
  if (!clip) return failure(head);
  const caption = clip.caption.trim();
  const author = clip.display_name || clip.handle;
  const photos = clip.image_ids ?? [];
  const name = excerpt(caption, 90) || (photos.length ? 'Photos by @' : 'Short video by @') + clip.handle;
  const title = excerpt(name, 62) + ' | ' + brand;
  const description = excerpt((caption ? caption + ' — ' : '') + (photos.length ? 'See this photo post by @' : 'Watch this short video by @') + clip.handle + ' on ' + brand + '.', 160);
  const path = watchPath(id);
  if (photos.length) {
    const image = mediaUrl(photos[0], 'jpg');
    const slides = photos.map((photo, i) => '<figure><img src="' + mediaUrl(photo, 'jpg') + '" alt="Photo ' +
      (i + 1) + ' of ' + photos.length + '"' + (i ? ' loading="lazy"' : '') + '></figure>').join('');
    return page(head, {
      title, description, path, image, imageAlt: 'First photo by @' + clip.handle,
      content: '<article class="watch"><div class="watch-photos" role="region" aria-label="Photo gallery" tabindex="0">' + slides +
        '</div><h1>' + escape(caption || name) + '</h1><a class="primary" href="/?v=' + id + '&amp;app=1">Open comments and reactions</a></article>',
    });
  }
  const poster = mediaUrl(id, 'jpg');
  const playback = mediaUrl(id, 'mp4');
  return page(head, {
    title, description, path, image: poster, imageAlt: 'Video frame from ' + name, video: true,
    schema: {
      '@context': 'https://schema.org', '@type': 'VideoObject', name, description, thumbnailUrl: [poster],
      uploadDate: clip.created_at, contentUrl: playback, url: origin + path,
      creator: { '@type': 'Person', name: author, url: origin + creatorPath(clip.handle) },
    },
    content: '<article class="watch"><video controls playsinline preload="metadata" poster="' + poster + '" aria-label="' + escape(name) +
      '"><source src="' + playback + '" type="video/mp4"><a href="' + playback + '">Open the video file</a></video>' +
      '<h1>' + escape(caption || name) + '</h1><p>By <a href="' + escape(creatorPath(clip.handle)) + '">@' +
      escape(clip.handle) + '</a></p><a class="primary" href="/?v=' + id + '&amp;app=1">Open comments and reactions</a></article>',
  });
}

async function catalog(head, url, handle) {
  const base = handle ? creatorPath(handle) : '/videos';
  const query = new URLSearchParams({ galleries: 'true' });
  if (handle) query.set('creator', handle);
  const cursor = new URLSearchParams();
  if (url.searchParams.has('at') || url.searchParams.has('after')) {
    const at = url.searchParams.get('at') ?? '';
    const after = url.searchParams.get('after') ?? '';
    if (!timestamp.test(at) || !Number.isFinite(Date.parse(at)) || !videoId.test(after)) return failure(head);
    cursor.set('at', at);
    cursor.set('after', after.toLowerCase());
    for (const [key, value] of cursor) query.set(key, value);
  }
  const { items, next } = await api('/videos?' + query);
  if (!items.length && (handle || cursor.size)) return failure(head);
  const heading = handle ? 'Short videos by @' + handle : 'Kenyan short videos';
  const description = handle ? 'Watch short videos posted by @' + handle + ' on ' + brand + '.' :
    'Browse the latest public short videos from Kenyan creators on TikTok Mwitu.';
  const path = base + (cursor.size ? '?' + cursor : '');
  const cards = items.map(clip => '<li><a href="' + watchPath(clip.id) + '">' +
    '<img src="' + mediaUrl(clip.image_ids?.[0] ?? clip.id, 'jpg') + '" alt="" width="320" height="200" loading="lazy">' +
    '<span class="clip-title">' + escape(excerpt(clip.caption, 120) || 'Short video') + '</span><small>@' + escape(clip.handle) +
    '</small></a></li>').join('');
  return page(head, { title: heading + ' | ' + brand, description, path,
    content: '<h1>' + heading + '</h1><p>' + description + '</p>' +
      (cards ? '<ul class="clips">' + cards + '</ul>' : '<p>New clips will appear here as creators post them.</p>') +
      '<nav class="pages" aria-label="Video pages">' + (cursor.size ? '<a href="' + base + '">Latest videos</a>' : '') +
      (next ? '<a href="' + escape(base + '?' + new URLSearchParams(next)) + '">Older videos</a>' : '') + '</nav>',
  });
}

function live(head) {
  return page(head, {
    title: 'Watch Kenyan LIVE Streams | TikTok Mwitu',
    description: 'Discover live streams from Kenyan creators on TikTok Mwitu. Browse public rooms or join a host with the invite code they share.',
    path: '/live',
    content: '<h1>Watch Kenyan LIVE streams</h1><p>Meet Kenyan creators as they go live. Watch public broadcasts and join the chat when the host has it enabled.</p>' +
      '<a class="primary" href="/?browse=live">Browse live rooms</a><h2>Joining with a code?</h2>' +
      '<p>Open the LIVE menu and enter the invite code shared by the host. You can watch without an account when the room allows guests.</p>',
  });
}

function xml(head, root, entries, namespaces = '') {
  return respond('<?xml version="1.0" encoding="UTF-8"?>\n<' + root +
    ' xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"' + namespaces + '>\n' + entries.join('\n') + '\n</' + root + '>\n',
    head, 'application/xml');
}

async function sitemap(head, path) {
  if (path === '/sitemap.xml') {
    const { pages } = await api('/discovery/video-sitemap');
    if (!Number.isInteger(pages) || pages < 1 || pages > 50000) throw new Error('Invalid sitemap page count');
    return xml(head, 'sitemapindex', Array.from({ length: pages }, (_, index) =>
      '<sitemap><loc>' + origin + '/sitemap-videos-' + (index + 1) + '.xml</loc></sitemap>'));
  }
  const number = shardRoute.exec(path)?.[1];
  if (!number || Number(number) > 50000) return failure(head);
  const { items } = await api('/discovery/video-sitemap?page=' + number);
  if (number !== '1' && !items.length) return failure(head);
  const urls = number === '1' ? ['/', '/videos', '/live', '/download'].map(route => '<url><loc>' + origin + route + '</loc></url>') : [];
  for (const clip of items) {
    const name = escape(excerpt(clip.caption, 100) || 'Short video on TikTok Mwitu');
    const description = escape(excerpt(clip.caption, 1000) || 'Watch this short video on TikTok Mwitu.');
    urls.push('<url><loc>' + origin + watchPath(clip.id) + '</loc><lastmod>' + escape(clip.created_at) + '</lastmod>' +
      '<video:video><video:thumbnail_loc>' + mediaUrl(clip.id, 'jpg') + '</video:thumbnail_loc>' +
      '<video:title>' + name + '</video:title><video:description>' + description + '</video:description>' +
      '<video:content_loc>' + mediaUrl(clip.id, 'mp4') + '</video:content_loc>' +
      '<video:publication_date>' + escape(clip.created_at) + '</video:publication_date></video:video></url>');
  }
  return xml(head, 'urlset', urls, ' xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
}

export async function renderDiscovery(request, url) {
  const head = request.method === 'HEAD';
  const path = url.pathname;
  try {
    const video = watchRoute.exec(path);
    if (video) {
      const canonical = watchPath(video[1].toLowerCase());
      return path !== canonical ? Response.redirect(origin + canonical + url.search, 308) : await watch(head, video[1]);
    }
    const creator = creatorRoute.exec(path);
    if (creator) {
      const handle = creator[1].toLowerCase();
      const canonical = creatorPath(handle);
      return path !== canonical ? Response.redirect(origin + canonical + url.search, 308) : await catalog(head, url, handle);
    }
    if (path === '/videos/') return Response.redirect(origin + '/videos' + url.search, 308);
    if (path === '/videos') return await catalog(head, url);
    if (path === '/live/') return Response.redirect(origin + '/live' + url.search, 308);
    if (path === '/live') return live(head);
    if (path.startsWith('/sitemap')) return await sitemap(head, path);
    if (path.startsWith('/watch/') || path.startsWith('/creators/')) return failure(head);
    return null;
  } catch (error) {
    console.error('Public discovery unavailable', path, error.message);
    return failure(head, 503);
  }
}
