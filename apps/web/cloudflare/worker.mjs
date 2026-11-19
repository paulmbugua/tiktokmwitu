import { renderDiscovery } from './discovery.mjs';
import { handleMedia } from './media.mjs';

const publicHost = 'tiktokmwitu.co.ke';
const adminHost = 'admin.tiktokmwitu.co.ke';
const apiHost = 'https://api.tiktokmwitu.co.ke';
const mediaPath = /^\/media\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(mp4|jpg)$/;

function noIndex(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, headers });
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
      const privateView = ['live', 'room', 'topup', 'v', 'browse'].some(key => url.searchParams.has(key));
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
