
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rmdir, writeFile, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { db, mediaDir } from './infra';
import { cleanCloudVideo, playbackUrl, putCloudThumbnail, putCloudVideo, removeCloudThumbnail, useR2, type MediaStorage } from './media-storage';

const ffmpeg = promisify(execFile);
const diskReserve = Number(process.env.MEDIA_FREE_RESERVE_BYTES ?? 0);
let encoding = false;
const workDir = process.env.MEDIA_WORK_DIR ?? mediaDir;
const localThumbnail = (id: string) => join(mediaDir, 'public', id + '.jpg');
let thumbnailQueue: Promise<unknown> = Promise.resolve();
const pendingThumbnails = new Map<string, Promise<Buffer>>();

async function generateThumbnail(id: string, storage: MediaStorage) {
  let temporary: string | undefined;
  try {
    let video = join(mediaDir, 'public', id + '.mp4');
    if (storage === 'r2') {
      const response = await fetch(playbackUrl(id), { redirect: 'error', signal: AbortSignal.timeout(15000) });
      const bytes = Number(response.headers.get('content-length'));
      if (response.status === 404) throw new NotFoundException('Video unavailable.');
      if (!response.ok || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 32 * 1024 * 1024) {
        await response.body?.cancel();
        throw new ServiceUnavailableException('Video storage is unavailable.');
      }
      temporary = await mkdtemp(join(workDir, 'thumbnail-'));
      video = join(temporary, 'input.mp4');
      await writeFile(video, Buffer.from(await response.arrayBuffer()));
    }
    const { stdout: image } = await ffmpeg(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-format_whitelist', 'mov', '-threads', '1', '-i', video, '-map', '0:v:0',
      '-filter_threads', '1', '-vf',
      "thumbnail=24,scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease,setsar=1",
      '-frames:v', '1', '-c:v', 'mjpeg', '-threads', '1', '-q:v', '3', '-f', 'image2pipe', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: 512 * 1024, timeout: 15000, windowsHide: true });
    if (!image.length) throw new ServiceUnavailableException('Thumbnail unavailable.');
    if (storage === 'r2') await putCloudThumbnail(id, image);
    else await writeFile(localThumbnail(id), image);
    if (!(await db.query('SELECT 1 FROM videos WHERE id=$1', [id])).rowCount) {
      await removeThumbnail(id, storage);
      throw new NotFoundException('Video unavailable.');
    }
    return image;
  } finally {
    if (temporary) {
      await rm(join(temporary, 'input.mp4'), { force: true }).catch(() => undefined);
      await rmdir(temporary).catch(() => undefined);
    }
  }
}

function removeThumbnail(id: string, storage: MediaStorage) {
  if (storage === 'r2') return removeCloudThumbnail(id);
  return rm(localThumbnail(id), { force: true });
}

export async function getVideoThumbnail(id: string, storage: MediaStorage) {
  if (storage === 'r2') {
    const response = await fetch(playbackUrl(id, false, true), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    await response.body?.cancel();
    if (response.status !== 404) throw new ServiceUnavailableException('Thumbnail storage is unavailable.');
  } else {
    try { return await readFile(localThumbnail(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const pending = pendingThumbnails.get(id);
  if (pending) return pending;
  if (pendingThumbnails.size >= 12) throw new ServiceUnavailableException('Thumbnails are currently processing.');
  const generation = thumbnailQueue.then(() => generateThumbnail(id, storage))
    .finally(() => pendingThumbnails.delete(id));
  thumbnailQueue = generation.catch(() => undefined);
  pendingThumbnails.set(id, generation);
  return generation;
}

export async function saveVideo(upload: Buffer) {
  if (encoding) throw new ServiceUnavailableException('Another video is processing. Try again shortly.');
  encoding = true;
  const id = randomUUID();
  const incoming = join(workDir, 'incoming', id);
  const outputDir = useR2 ? join(workDir, 'processed') : join(mediaDir, 'public');
  const output = join(outputDir, id + '.mp4');
  try {
    await mkdir(workDir, { recursive: true });
    if (diskReserve > 0 && !useR2) {
      const disk = await statfs(mediaDir);
      if (disk.bavail * disk.bsize < diskReserve + upload.length + 32 * 1024 * 1024) {
        throw new ServiceUnavailableException('Video storage is temporarily full.');
      }
    }
    await mkdir(join(workDir, 'incoming'), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(incoming, upload, { flag: 'wx' });
    // Explicit container and protocol allowlists keep uploaded inputs self-contained.
    await ffmpeg(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm',
      '-threads', '2', '-i', incoming, '-t', '60', '-map', '0:v:0',
      '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
      '-filter_threads', '1', '-vf',
      "scale=w='min(720,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-crf', '26', '-maxrate', '1800k', '-bufsize', '3600k',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output,
    ], { timeout: 90000, windowsHide: true });
    if ((await stat(output)).size < 1024) throw new Error('No video frames');
    if (useR2) await putCloudVideo(id, output);
    return { id, storage: useR2 ? 'r2' as const : 'local' as const };
  } catch (error) {
    await rm(output, { force: true }).catch(() => undefined);
    if (error instanceof ServiceUnavailableException) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ServiceUnavailableException('Video encoder unavailable.');
    }
    throw new BadRequestException('Could not process the file. Try an MP4, MOV or WebM video.');
  } finally {
    await rm(incoming, { force: true }).catch(() => undefined);
    if (useR2) await rm(output, { force: true }).catch(() => undefined);
    encoding = false;
  }
}

export async function removeVideo(id: string, storage: MediaStorage) {
  if (storage === 'r2') return cleanCloudVideo(id);
  await Promise.all([rm(join(mediaDir, 'public', id + '.mp4'), { force: true }), removeThumbnail(id, storage)]);
}
