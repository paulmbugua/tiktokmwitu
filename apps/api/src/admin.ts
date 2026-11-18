import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { adminOrigin, db, parse, publishFeed, requireUser, uuid } from './infra';
import { removeVideo } from './media';
import type { MediaStorage } from './media-storage';
import { finishRoom } from './live';
import { lockedRoom } from './live-store';

const moderators = new Set((process.env.ADMIN_USER_IDS ?? '').split(',').map(id => id.trim().toLowerCase()).filter(Boolean));

async function requireAdmin(req: Request) {
  const suppliedOrigin = req.get('origin');
  if (suppliedOrigin && suppliedOrigin !== adminOrigin) {
    throw new ForbiddenException('Open the admin site to continue.');
  }
  const user = await requireUser(req);
  if (!moderators.has(user.id)) throw new ForbiddenException('Moderator access required.');
  return user;
}

@Controller('admin')
export class AdminController {
  @Get('me')
  async me(@Req() req: Request) {
    return requireAdmin(req);
  }

  @Get('live-reports')
  async liveReports(@Req() req: Request) {
    await requireAdmin(req);
    const { rows } = await db.query(`
      SELECT r.id,r.ended_at,u.handle,queue.total,queue.reasons
      FROM live_rooms r JOIN users u ON u.id=r.host_id
      JOIN LATERAL (
        SELECT count(*)::int AS total,max(updated_at) AS most_recent,
          (SELECT array_agg(reason) FROM (
            SELECT reason FROM live_reports WHERE room_id=r.id ORDER BY updated_at DESC LIMIT 5
          ) latest) AS reasons
        FROM live_reports WHERE room_id=r.id
      ) queue ON queue.total>0
      ORDER BY queue.most_recent DESC,r.id LIMIT 50`);
    return rows;
  }

  @Post('live-reports/:id')
  async reviewLive(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const actor = await requireAdmin(req);
    const id = uuid(raw);
    const { action } = parse(z.object({ action: z.enum(['dismiss', 'end']) }), body);
    if (action === 'end') {
      await finishRoom(id, 'moderated', actor);
    } else {
      await lockedRoom(id, async client => {
        const { rowCount } = await client.query('DELETE FROM live_reports WHERE room_id=$1', [id]);
        if (!rowCount) throw new NotFoundException('This room has no pending reports.');
        await client.query(`INSERT INTO live_audit(room_id,actor_id,action,details)
          VALUES ($1,$2,'platformDismiss',jsonb_build_object('count',$3::int))`, [id, actor.id, rowCount]);
      });
    }
    return { ok: true };
  }

  @Get('reports')
  async reports(@Req() req: Request) {
    await requireAdmin(req);
    const { rows } = await db.query(`
      SELECT v.id,v.caption,u.handle,queue.total,queue.reasons
      FROM videos v JOIN users u ON u.id=v.user_id
      JOIN LATERAL (
        SELECT count(*)::int AS total,
          (SELECT array_agg(reason ORDER BY created_at DESC)
            FROM (SELECT reason,created_at FROM reports WHERE video_id=v.id ORDER BY created_at DESC LIMIT 5) AS latest)
          AS reasons,
          max(created_at) AS updated_at
        FROM reports WHERE video_id=v.id
      ) queue ON queue.total>0
      ORDER BY queue.updated_at DESC,v.id LIMIT 50`);
    return rows;
  }

  @Post('reports/:id')
  async review(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const user = await requireAdmin(req);
    const id = uuid(raw);
    const { action } = parse(z.object({ action: z.enum(['dismiss', 'remove']) }), body);
    const client = await db.connect();
    let storage: MediaStorage = 'local';
    try {
      await client.query('BEGIN');
      const video = await client.query<{ media_storage: MediaStorage }>('SELECT media_storage FROM videos WHERE id=$1 FOR UPDATE', [id]);
      if (!video.rowCount) throw new NotFoundException('Video unavailable.');
      storage = video.rows[0].media_storage;
      const reports = await client.query('DELETE FROM reports WHERE video_id=$1', [id]);
      if (!reports.rowCount) throw new NotFoundException('This video has no pending reports.');
      if (action === 'remove') {
        await client.query('DELETE FROM videos WHERE id=$1', [id]);
        if (storage === 'r2') await client.query('INSERT INTO video_media_cleanup(id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      }
      await client.query(
        'INSERT INTO moderation_actions(actor_id,video_id,action,report_count) VALUES ($1,$2,$3,$4)',
        [user.id, id, action, reports.rowCount]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (action === 'remove') {
      publishFeed();
      await removeVideo(id, storage).catch(error => console.error('Removed media file needs cleanup', id, error));
    }
    return { ok: true };
  }
}
