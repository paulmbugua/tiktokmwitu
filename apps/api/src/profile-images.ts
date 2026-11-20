import { BadRequestException, Controller, Delete, Param, Put, Req, ServiceUnavailableException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Request } from 'express';
import { z } from 'zod';
import { db, mediaDir, parse, publishFeed, requireUser, SessionGuard } from './infra';
import { playbackUrl, putCloudThumbnail, removeCloudThumbnail, useR2, type MediaStorage } from './media-storage';

const fileLimit = 6 * 1024 * 1024;
const outputLimit = 512 * 1024;
const directory = join(mediaDir, 'profiles');
const kindSchema = z.enum(['avatar', 'cover']);
type ImageRow = { id: string; storage: MediaStorage };
const ffmpeg = promisify(execFile);

function formatOf(bytes: Buffer) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg_pipe';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png_pipe';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp_pipe';
  throw new BadRequestException('Choose a JPEG, PNG or WebP image.');
}

async function prepareImage(bytes: Buffer, kind: z.infer<typeof kindSchema>) {
  const format = formatOf(bytes);
  const folder = await mkdtemp(join(process.env.MEDIA_WORK_DIR ?? mediaDir, 'profile-'));
  try {
    const input = join(folder, 'source');
    await writeFile(input, bytes);
    const [width, height] = kind === 'avatar' ? [512, 512] : [1200, 540];
    const crop = `crop=w='min(iw,ih*${width}/${height})':h='min(ih,iw*${height}/${width})'`;
    const { stdout } = await ffmpeg(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-threads', '1', '-max_pixels', '40000000', '-f', format, '-i', input, '-map', '0:v:0',
      '-filter_threads', '1', '-vf', `${crop},scale=${width}:${height},setsar=1`,
      '-frames:v', '1', '-map_metadata', '-1', '-c:v', 'mjpeg', '-threads', '1', '-q:v', '6', '-f', 'image2pipe', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: outputLimit, timeout: 12000, windowsHide: true });
    if (!stdout.length) throw new Error('Image produced no output');
    return stdout;
  } catch {
    throw new BadRequestException('Could not read this photo. Try a smaller JPEG, PNG or WebP image.');
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

const localPath = (id: string) => join(directory, id + '.jpg');

export async function readProfileImage({ id, storage }: ImageRow) {
  if (storage === 'local') return readFile(localPath(id));
  const response = await fetch(playbackUrl(id, false, true), { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceUnavailableException('Profile photo is unavailable.');
  }
  return Buffer.from(await response.arrayBuffer());
}

async function changePhoto(owner: string, kind: string, next?: ImageRow) {
  const client = await db.connect();
  let previous: ImageRow | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
    previous = (await client.query<ImageRow>(
      'DELETE FROM profile_images WHERE user_id=$1 AND kind=$2 RETURNING id,storage', [owner, kind])).rows[0];
    if (next) await client.query('INSERT INTO profile_images(id,user_id,kind,storage) VALUES ($1,$2,$3,$4)', [next.id, owner, kind, next.storage]);
    if (previous?.storage === 'r2') {
      await client.query('INSERT INTO video_media_cleanup(id,thumbnail_only) VALUES ($1,true) ON CONFLICT DO NOTHING', [previous.id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (previous?.storage === 'local') await rm(localPath(previous.id), { force: true }).catch(() => undefined);
  publishFeed();
}

@Controller('account/profile/images')
@UseGuards(SessionGuard)
export class ProfileImagesController {
  @Put(':kind')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: fileLimit, files: 1, fields: 0 } }))
  async upload(@Req() req: Request, @Param('kind') raw: string, @UploadedFile() file?: { buffer: Buffer }) {
    const owner = await requireUser(req);
    const kind = parse(kindSchema, raw);
    if (!file?.buffer.length) throw new BadRequestException('Choose a photo.');
    const image = await prepareImage(file.buffer, kind);
    const next: ImageRow = { id: randomUUID(), storage: useR2 ? 'r2' : 'local' };
    try {
      if (useR2) await putCloudThumbnail(next.id, image);
      else {
        await mkdir(directory, { recursive: true });
        await writeFile(localPath(next.id), image, { flag: 'wx' });
      }
      await changePhoto(owner.id, kind, next);
    } catch (error) {
      await (useR2 ? removeCloudThumbnail(next.id) : rm(localPath(next.id), { force: true })).catch(() => undefined);
      throw error;
    }
    return { id: next.id };
  }

  @Delete(':kind')
  async remove(@Req() req: Request, @Param('kind') raw: string) {
    const owner = await requireUser(req);
    await changePhoto(owner.id, parse(kindSchema, raw));
    return { ok: true };
  }
}
