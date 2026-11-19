const pathPattern = /^\/internal\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(mp4|jpg)$/;
const maxBytes = 32 * 1024 * 1024;
const encode = new TextEncoder();

async function authorized(request, url, secret, operation) {
  if (!secret) return false;
  const token = request.headers.get('authorization');
  const credential = operation === 'read' ? url.searchParams.get('access') : token?.startsWith('Bearer ') ? token.slice(7) : null;
  const fields = /^(\d{10})\.([0-9a-f]{64})$/.exec(credential ?? '');
  if (!fields) return false;
  const [, expires, signature] = fields;
  const now = Math.floor(Date.now() / 1000);
  if (+expires < now || +expires > now + 3600) return false;
  const key = await crypto.subtle.importKey('raw', encode.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.match(/../g), digit => parseInt(digit, 16));
  return crypto.subtle.verify('HMAC', key, bytes, encode.encode(operation + ':' + url.pathname + ':' + expires));
}

export function readRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !size || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const length = Math.min(size, Number(match[2]));
    return length > 0 ? { offset: size - length, length } : null;
  }
  const offset = Number(match[1]);
  const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return offset < size && offset <= end ? { offset, length: end - offset + 1 } : null;
}

export async function handleMedia(request, url, env) {
  const match = pathPattern.exec(url.pathname);
  if (!match) return new Response(null, { status: 404 });
  const [, id, extension] = match;
  const contentType = extension === 'jpg' ? 'image/jpeg' : 'video/mp4';
  const method = request.method;
  const operation = ['GET', 'HEAD'].includes(method) ? 'read' : method;
  if (!['read', 'PUT', 'DELETE'].includes(operation)) return new Response(null, { status: 405 });
  if (!await authorized(request, url, env.MEDIA_STORAGE_SECRET, operation)) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const objectKey = (extension === 'jpg' ? 'thumbnails/' : 'videos/') + id + '.' + extension;
  const bucket = env.MEDIA_BUCKET;
  if (method === 'PUT') {
    const bytes = Number(request.headers.get('content-length'));
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > (extension === 'jpg' ? 512 * 1024 : maxBytes) || !request.body) {
      return new Response(null, { status: 413 });
    }
    await bucket.put(objectKey, request.body, { httpMetadata: { contentType } });
    return new Response(null, { status: 201 });
  }
  if (method === 'DELETE') {
    await bucket.delete(objectKey);
    return new Response(null, { status: 204 });
  }

  const rangeHeader = request.headers.get('range');
  const info = method === 'HEAD' || rangeHeader ? await bucket.head(objectKey) : await bucket.get(objectKey);
  if (!info) return new Response(null, { status: 404 });
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-site',
    'X-Content-Type-Options': 'nosniff',
    'ETag': info.httpEtag,
    'Content-Length': String(info.size),
  });
  if (extension === 'mp4' && url.searchParams.get('download') === '1') headers.set('Content-Disposition', 'attachment; filename="mwitu-' + id + '.mp4"');
  if (method === 'HEAD') return new Response(null, { headers });
  if (!rangeHeader) return new Response(info.body, { headers });
  const range = readRange(rangeHeader, info.size);
  if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + info.size } });
  const partial = await bucket.get(objectKey, { range, onlyIf: { etagMatches: info.etag } });
  if (!partial?.body) return new Response(null, { status: 404 });
  headers.set('Content-Length', String(range.length));
  headers.set('Content-Range', 'bytes ' + range.offset + '-' + (range.offset + range.length - 1) + '/' + info.size);
  return new Response(partial.body, { status: 206, headers });
}
