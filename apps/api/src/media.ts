
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { mediaDir } from './infra';

const ffmpeg = promisify(execFile);
let encoding = false;

export async function saveVideo(upload: Buffer) {
  if (encoding) throw new ServiceUnavailableException('Another video is processing. Try again shortly.');
  encoding = true;
  const id = randomUUID();
  const incoming = join(mediaDir, 'incoming', id);
  const output = join(mediaDir, 'public', id + '.mp4');
  try {
    await mkdir(join(mediaDir, 'incoming'), { recursive: true });
    await mkdir(join(mediaDir, 'public'), { recursive: true });
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
    return id;
  } catch (error) {
    await rm(output, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ServiceUnavailableException('Video encoder unavailable.');
    }
    throw new BadRequestException('Could not process the file. Try an MP4, MOV or WebM video.');
  } finally {
    encoding = false;
    await rm(incoming, { force: true }).catch(() => undefined);
  }
}

export function removeVideo(id: string) {
  return rm(join(mediaDir, 'public', id + '.mp4'), { force: true });
}
