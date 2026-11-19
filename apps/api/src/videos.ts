
import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post,
  Put, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import {
  cleanText, cookie, db, handleSchema, identity, parse, publishFeed, requireUser,
  searchSchema, uploadLimit, uuid, SessionGuard,
} from './infra';
import { removeVideo, saveVideo } from './media';
import type { MediaStorage } from './media-storage';

const videoFields = z.object({ caption: cleanText(500) });
const textBody = z.object({ body: cleanText(500) });
const enabledBody = z.object({ enabled: z.boolean() });
const clientCursor = z.object({ at: z.iso.datetime(), id: z.uuid() });
const sitemapPageSize = 1000;
const projection = `
  v.id,v.caption,v.created_at,u.handle,u.display_name,u.id AS creator_id,
  (SELECT count(*)::int FROM likes l WHERE l.video_id=v.id) AS likes,
  (SELECT count(*)::int FROM comments c WHERE c.video_id=v.id) AS comments,
  EXISTS(SELECT 1 FROM likes l WHERE l.video_id=v.id AND l.user_id=$1) AS liked,
  EXISTS(SELECT 1 FROM follows f WHERE f.creator_id=u.id AND f.follower_id=$1) AS following,
  EXISTS(SELECT 1 FROM saved_videos s WHERE s.video_id=v.id AND s.user_id=$1) AS saved`;
const cursorAt = (column: 'v.created_at' | 's.saved_at') =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;
function feedPage(rows: { id: string; cursor_at: string }[]) {
  const last = rows[11];
  return { items: rows.slice(0, 12), next: rows.length > 12 ? { at: last.cursor_at, after: last.id } : null };
}

export async function assertVideo(id: string) {
  if (!(await db.query('SELECT 1 FROM videos WHERE id=$1', [id])).rowCount) {
    throw new NotFoundException('Video unavailable.');
  }
}

@Controller()
export class VideosController {
  @Get('discovery/video-sitemap')
  async videoSitemap(@Query('page') raw?: string) {
    if (raw === undefined) {
      const { rows: [result] } = await db.query<{ pages: number }>(
        'SELECT ceil(count(*)::numeric / $1)::int AS pages FROM videos', [sitemapPageSize]);
      return { pages: Math.max(1, result.pages) };
    }
    const page = parse(z.coerce.number().int().min(1).max(50000), raw);
    const { rows } = await db.query(
      'SELECT id,caption,created_at FROM videos ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2',
      [sitemapPageSize, (page - 1) * sitemapPageSize]);
    return { items: rows };
  }

  @Get('videos')
  async feed(@Req() req: Request, @Query() query: Record<string, unknown>) {
    const user = await identity(req.cookies[cookie]);
    const input = parse(z.object({
      following: z.enum(['true', 'false']).optional(),
      q: searchSchema.optional(),
      creator: handleSchema.optional(),
      at: clientCursor.shape.at.optional(),
      after: clientCursor.shape.id.optional(),
    }), query);
    if (Boolean(input.at) !== Boolean(input.after)) throw new BadRequestException('Invalid feed cursor.');
    const { rows } = await db.query(`
      SELECT ${projection}, ${cursorAt('v.created_at')} FROM videos v JOIN users u ON u.id=v.user_id
      WHERE (NOT $2::boolean OR EXISTS (
        SELECT 1 FROM follows f WHERE f.creator_id=u.id AND f.follower_id=$1))
      AND ($3::text IS NULL OR strpos(lower(v.caption || ' ' || u.handle || ' ' || u.display_name),lower($3)) > 0)
      AND ($4::text IS NULL OR u.handle=$4)
      AND ($5::timestamptz IS NULL OR (v.created_at,v.id)<($5,$6::uuid))
      ORDER BY v.created_at DESC,v.id DESC LIMIT 13`,
      [user?.id ?? null, input.following === 'true', input.q || null, input.creator ?? null, input.at ?? null, input.after ?? null]);
    return feedPage(rows);
  }

  @Get('videos/saved')
  async saved(@Req() req: Request, @Query() query: Record<string, unknown>) {
    const user = await requireUser(req);
    const input = parse(z.object({ at: clientCursor.shape.at.optional(), after: clientCursor.shape.id.optional() }), query);
    if (Boolean(input.at) !== Boolean(input.after)) throw new BadRequestException('Invalid saved videos cursor.');
    const { rows } = await db.query(`
      SELECT ${projection}, ${cursorAt('s.saved_at')}
      FROM saved_videos s JOIN videos v ON v.id=s.video_id JOIN users u ON u.id=v.user_id
      WHERE s.user_id=$1 AND ($2::timestamptz IS NULL OR (s.saved_at,s.video_id)<($2,$3::uuid))
      ORDER BY s.saved_at DESC,s.video_id DESC LIMIT 13`, [user.id, input.at ?? null, input.after ?? null]);
    return feedPage(rows);
  }

  @Get('videos/:id')
  async video(@Param('id') raw: string, @Req() req: Request) {
    const id = uuid(raw);
    const user = await identity(req.cookies[cookie]);
    const { rows: [video] } = await db.query(`
      SELECT ${projection} FROM videos v JOIN users u ON u.id=v.user_id WHERE v.id=$2`, [user?.id ?? null, id]);
    if (!video) throw new NotFoundException('Video unavailable.');
    return video;
  }

  @Post('videos')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseGuards(SessionGuard)
  @UseInterceptors(FileInterceptor('video', { limits: { fileSize: uploadLimit, files: 1, fields: 2, fieldSize: 2048 } }))
  async upload(
    @Req() req: Request, @Body() body: unknown, @UploadedFile() file?: { buffer: Buffer },
  ) {
    const user = await requireUser(req);
    const { caption } = parse(videoFields, body);
    if (!file?.buffer.length) throw new BadRequestException('Choose a video.');
    const { id: mediaId, storage } = await saveVideo(file.buffer);
    try {
      await db.query('INSERT INTO videos(id,user_id,caption,media_storage) VALUES ($1,$2,$3,$4)',
        [mediaId, user.id, caption, storage]);
    } catch (error) {
      await removeVideo(mediaId, storage).catch(() => undefined);
      throw error;
    }
    publishFeed();
    return { id: mediaId };
  }

  @Delete('videos/:id')
  async delete(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const { rows: [video] } = await db.query<{ media_storage: MediaStorage }>(`
      WITH removed AS (DELETE FROM videos WHERE id=$1 AND user_id=$2 RETURNING id,media_storage),
        queued AS (INSERT INTO video_media_cleanup(id) SELECT id FROM removed WHERE media_storage='r2'
          ON CONFLICT DO NOTHING)
      SELECT media_storage FROM removed`, [id, user.id]);
    if (!video) throw new NotFoundException('Video unavailable.');
    await removeVideo(id, video.media_storage).catch(error => console.error('Removed media file needs cleanup', id, error));
    publishFeed();
    return { ok: true };
  }

  @Put('videos/:id/like')
  async like(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const { enabled } = parse(enabledBody, body);
    await assertVideo(id);
    if (enabled) await db.query('INSERT INTO likes VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, user.id]);
    else await db.query('DELETE FROM likes WHERE video_id=$1 AND user_id=$2', [id, user.id]);
    publishFeed();
    return { ok: true };
  }

  @Get('videos/:id/comments')
  async comments(@Param('id') raw: string) {
    return (await db.query(`
      SELECT c.id,c.body,c.created_at,u.handle
      FROM comments c JOIN users u ON u.id=c.user_id
      WHERE c.video_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 100`, [uuid(raw)])).rows;
  }

  @Put('videos/:id/save')
  async save(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const { enabled } = parse(enabledBody, body);
    if (enabled) {
      const result = await db.query(`
        INSERT INTO saved_videos(user_id,video_id) SELECT $1,id FROM videos WHERE id=$2 FOR KEY SHARE
        ON CONFLICT DO NOTHING RETURNING video_id`, [user.id, id]);
      if (!result.rowCount) await assertVideo(id);
    } else {
      await db.query('DELETE FROM saved_videos WHERE user_id=$1 AND video_id=$2', [user.id, id]);
    }
    return { ok: true };
  }

  @Post('videos/:id/comments')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async comment(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const input = parse(textBody, body);
    await assertVideo(id);
    await db.query('INSERT INTO comments(video_id,user_id,body) VALUES ($1,$2,$3)', [id, user.id, input.body]);
    publishFeed();
    return { ok: true };
  }

  @Post('videos/:id/report')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  async report(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const { reason } = parse(z.object({ reason: cleanText(500) }), body);
    await assertVideo(id);
    await db.query(`
      INSERT INTO reports(video_id,user_id,reason) VALUES ($1,$2,$3)
      ON CONFLICT(video_id,user_id) DO UPDATE SET reason=excluded.reason,created_at=now()`,
      [id, user.id, reason]);
    return { ok: true };
  }
}
