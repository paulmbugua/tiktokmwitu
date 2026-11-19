import { renderDiscovery } from './discovery.mjs';
import { handleMedia, readRange } from './media.mjs';

const publicHost = 'tiktokmwitu.co.ke';
const adminHost = 'admin.tiktokmwitu.co.ke';
const apiHost = 'https://api.tiktokmwitu.co.ke';
const androidFile = 'tiktok-mwitu-1.0.2.apk';
const androidReleases = new Set([androidFile, 'tiktok-mwitu-1.0.1.apk', 'tiktok-mwitu-1.0.0.apk']);
const liveInvitePath = /^\/join\/(\d{6}|[0-9A-F]{16})\/?$/i;
const mediaPath = /^\/media\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(mp4|jpg)$/;

function noIndex(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, headers });
}

async function androidDownload(request, bucket, file) {
  const key = 'releases/' + file;
  const head = request.method === 'HEAD';
  const requestedRange = head ? null : request.headers.get('Range');
  const object = head || requestedRange ? await bucket.head(key) : await bucket.get(key);
  if (!object) return new Response('This release is temporarily unavailable.', {
    status: 404, headers: { 'Cache-Control': 'no-store' },
  });
  const headers = new Headers({
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': String(object.size),
    'Content-Disposition': 'attachment; filename="' + file + '"',
    'Cache-Control': 'public, max-age=86400, immutable',
    'Accept-Ranges': 'bytes',
    'ETag': object.httpEtag,
    'X-Content-Type-Options': 'nosniff',
  });
  if (!requestedRange) return new Response(head ? null : object.body, { headers });
  const range = readRange(requestedRange, object.size);
  if (!range) return new Response(null, {
    status: 416, headers: { 'Content-Range': 'bytes */' + object.size, 'Cache-Control': 'no-store' },
  });
  const partial = await bucket.get(key, { range, onlyIf: { etagMatches: object.etag } });
  if (!partial?.body) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  headers.set('Content-Length', String(range.length));
  headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  return new Response(partial.body, { status: 206, headers });
}

async function publicMedia(request, url, env) {
  if (!mediaPath.test(url.pathname)) return new Response(null, { status: 404 });
  const headers = new Headers();
  const range = request.headers.get('Range');
  if (range && url.pathname.endsWith('.mp4')) headers.set('Range', range);
  try {
    const response = await fetch(apiHost + url.pathname, {
      method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(25000),
    });
    if (response.status !== 307) return response;
    const destination = new URL(response.headers.get('Location') ?? '', url);
    if (destination.origin !== url.origin || destination.pathname !== '/internal' + url.pathname) {
      throw new Error('Unexpected public media redirect');
    }
    return await handleMedia(request, destination, env);
  } catch {
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '15' } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const publicSite = url.hostname === publicHost;
    const adminSite = url.hostname === adminHost;
    const retrieval = request.method === 'GET' || request.method === 'HEAD';
    if (publicSite && retrieval) {
      const invite = liveInvitePath.exec(url.pathname);
      if (invite) return noIndex(Response.redirect(new URL('/?live=' + invite[1], url), 302));
      if (url.pathname === '/download/android') {
        return Response.redirect(new URL('/download/' + androidFile, url), 302);
      }
      const file = url.pathname.slice('/download/'.length);
      if (url.pathname.startsWith('/download/') && androidReleases.has(file)) {
        return androidDownload(request, env.MEDIA_BUCKET, file);
      }
      if (url.pathname === '/download') {
        return env.ASSETS.fetch(new Request(new URL('/download.html', url), request));
      }
    }
    if (url.pathname.startsWith('/internal/media/')) {
      return publicSite ? handleMedia(request, url, env) : new Response(null, { status: 404 });
    }
    if (url.pathname.startsWith('/media/') && retrieval && publicSite) return publicMedia(request, url, env);
    if (url.pathname === '/robots.txt' && retrieval) {
      const lines = ['User-agent: *', 'Allow: /'];
      if (publicSite) lines.push('Sitemap: https://tiktokmwitu.co.ke/sitemap.xml');
      return new Response(request.method === 'HEAD' ? null : lines.join('\n') + '\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    }
    if (publicSite && url.pathname.toLowerCase().startsWith('/admin')) {
      return noIndex(new Response('Not found', { status: 404 }));
    }
    if (retrieval && url.pathname === '/index.html') {
      return Response.redirect(new URL('/' + url.search, url), 308);
    }
    if (retrieval && url.pathname === '/') {
      const id = url.searchParams.get('v');
      if (publicSite && [...url.searchParams].length === 1 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '')) {
        return Response.redirect(new URL('/watch/' + id.toLowerCase(), url), 308);
      }
      const privateView = ['live', 'room', 'topup', 'v', 'browse', 'google'].some(key => url.searchParams.has(key));
      url.pathname = adminSite ? '/admin.html' : '/index.html';
      const response = await env.ASSETS.fetch(new Request(url, request));
      if (adminSite || privateView) return noIndex(response);
      return response;
    }
    if (retrieval && publicSite) {
      const discovery = await renderDiscovery(request, url);
      if (discovery) return discovery;
    }
    const response = await env.ASSETS.fetch(request);
    return adminSite ? noIndex(response) : response;
  },
};
