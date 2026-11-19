// Keep LIVE, media, account data and app updates on the normal network path.
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.mode !== 'navigate' || request.method !== 'GET' || url.origin !== self.location.origin || url.pathname !== '/') return;

  event.respondWith(fetch(request).catch(() => new Response(`<!doctype html>
<html lang="en-KE"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#15121b"><title>Tiktok mwitu</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:#15121b;color:#f8f2fb;font:16px/1.5 system-ui}main{padding:24px;max-width:27rem;border:1px solid #564460;border-radius:20px;background:#211b2a}a{color:#d3fc77;font-weight:700}</style>
<main><h1>You’re offline</h1><p>Reconnect to load Tiktok mwitu videos and LIVE.</p><a href="">Try again</a></main></html>`, {
    status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })));
});
