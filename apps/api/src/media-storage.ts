import { createHmac } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { db, mediaDir } from './infra';

const origin = process.env.R2_MEDIA_ORIGIN;
const secret = process.env.MEDIA_STORAGE_SECRET;
if (Boolean(secret) !== Boolean(origin)) throw new Error('Set both R2_MEDIA_ORIGIN and MEDIA_STORAGE_SECRET.');
if (origin && !/^https:\/\//.test(origin)) throw new Error('R2_MEDIA_ORIGIN must use HTTPS.');
export const useR2 = Boolean(origin);
export type MediaStorage = 'local' | 'r2';

function objectUrl(id: string, thumbnail = false) {
  return new URL('/internal/media/' + id + (thumbnail ? '.jpg' : '.mp4'), origin);
}

function access(operation: string, url: URL) {
  if (!secret) throw new ServiceUnavailableException('Cloud media storage is unavailable.');
  const expires = Math.floor(Date.now() / 1000) + (operation === 'read' ? 900 : 90);
  const signature = createHmac('sha256', secret).update(operation + ':' + url.pathname + ':' + expires).digest('hex');
  return expires + '.' + signature;
}

export function playbackUrl(id: string, download = false, thumbnail = false) {
  if (!useR2) throw new ServiceUnavailableException('Cloud media storage is unavailable.');
  const url = objectUrl(id, thumbnail);
  url.searchParams.set('access', access('read', url));
  if (download) url.searchParams.set('download', '1');
  return url.href;
}

async function write(id: string, method: 'PUT' | 'DELETE', body?: Buffer, thumbnail = false) {
  try {
    const url = objectUrl(id, thumbnail);
    const headers: Record<string, string> = { Authorization: 'Bearer ' + access(method, url) };
    if (body) {
      headers['Content-Type'] = thumbnail ? 'image/jpeg' : 'video/mp4';
      headers['Content-Length'] = String(body.length);
    }
    const response = await fetch(url, { method, body: body ? new Uint8Array(body) : undefined, headers,
      signal: AbortSignal.timeout(25000), redirect: 'error' });
    if (!response.ok) throw new Error('Storage returned HTTP ' + response.status);
  } catch (error) {
    console.error('Cloud media operation failed', method, id, (error as Error).message);
    throw new ServiceUnavailableException('Cloud media storage is temporarily unavailable.');
  }
}

export async function putCloudVideo(id: string, path: string) {
  await write(id, 'PUT', await readFile(path));
}

export function putCloudThumbnail(id: string, image: Buffer) {
  return write(id, 'PUT', image, true);
}

export function removeCloudThumbnail(id: string) {
  return write(id, 'DELETE', undefined, true);
}

let cleaning = false;
export async function cleanCloudVideo(id: string) {
  await Promise.all([write(id, 'DELETE'), removeCloudThumbnail(id)]);
  await db.query('DELETE FROM video_media_cleanup WHERE id=$1', [id]);
}

export async function sweepCloudMedia() {
  if (cleaning) return;
  cleaning = true;
  try {
    const { rows } = await db.query<{ id: string; thumbnail_only: boolean; local_image: boolean }>(
      'SELECT id,thumbnail_only,local_image FROM video_media_cleanup WHERE $1 OR local_image ORDER BY queued_at LIMIT 20', [useR2]);
    for (const { id, thumbnail_only, local_image } of rows) {
      if (thumbnail_only) {
        const removed = local_image ? rm(join(mediaDir, 'profiles', id + '.jpg'), { force: true }) : removeCloudThumbnail(id);
        await removed.then(() => db.query('DELETE FROM video_media_cleanup WHERE id=$1', [id])).catch(() => undefined);
      } else await cleanCloudVideo(id).catch(() => undefined);
    }
  } finally {
    cleaning = false;
  }
}
