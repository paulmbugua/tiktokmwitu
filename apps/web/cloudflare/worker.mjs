const publicHost = 'tiktokmwitu.co.ke';
const adminHost = 'admin.tiktokmwitu.co.ke';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const adminPath = url.pathname.toLowerCase().startsWith('/admin');
    if (url.hostname === publicHost && adminPath) {
      return new Response('Not found', { status: 404 });
    }
    if (url.pathname === '/') {
      url.pathname = url.hostname === adminHost ? '/admin.html' : '/index.html';
      return env.ASSETS.fetch(new Request(url, request));
    }
    if (url.hostname === adminHost && url.pathname === '/index.html') {
      return Response.redirect(new URL('/', url), 302);
    }
    return env.ASSETS.fetch(request);
  },
};
