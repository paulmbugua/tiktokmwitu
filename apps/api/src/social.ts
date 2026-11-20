
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import {
  cleanText, cookie, db, handleSchema, identity, parse, publishFeed, publishInbox, requireUser,
  type Person,
} from './infra';

async function person(handle: string) {
  const { rows: [user] } = await db.query<Person>(
    'SELECT id,handle,display_name FROM users WHERE handle=$1', [parse(handleSchema, handle)]);
  if (!user) throw new NotFoundException('Creator not found.');
  return user;
}

@Controller()
export class SocialController {
  @Get('creators/:handle')
  async profile(@Req() req: Request, @Param('handle') handle: string) {
    const creator = await person(handle);
    const viewer = await identity(req.cookies[cookie]);
    const { rows: [stats] } = await db.query(`
      SELECT
        (SELECT count(*)::int FROM follows WHERE creator_id=$1) AS followers,
        (SELECT count(*)::int FROM follows WHERE follower_id=$1) AS following_count,
        (SELECT count(*)::int FROM likes l JOIN videos v ON v.id=l.video_id WHERE v.user_id=$1) AS likes,
        EXISTS(SELECT 1 FROM follows WHERE creator_id=$1 AND follower_id=$2) AS following,
        bio,website FROM users WHERE id=$1`,
      [creator.id, viewer?.id ?? null]);
    return { ...creator, ...stats };
  }

  @Put('account/profile')
  async editProfile(@Req() req: Request, @Body() body: unknown) {
    const user = await requireUser(req);
    const profile = parse(z.object({
      display_name: cleanText(48),
      bio: z.union([z.literal(''), cleanText(160)]),
      website: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(300)]),
    }), body);
    const { rows: [updated] } = await db.query<Person>(`
      UPDATE users SET display_name=$2,bio=$3,website=$4 WHERE id=$1 RETURNING id,handle,display_name`,
      [user.id, profile.display_name, profile.bio, profile.website]);
    publishFeed();
    return updated;
  }

  @Put('creators/:handle/follow')
  async follow(@Req() req: Request, @Param('handle') handle: string, @Body() body: unknown) {
    const user = await requireUser(req);
    const creator = await person(handle);
    if (user.id === creator.id) throw new BadRequestException('You cannot follow yourself.');
    const { enabled } = parse(z.object({ enabled: z.boolean() }), body);
    if (enabled) await db.query('INSERT INTO follows VALUES ($1,$2) ON CONFLICT DO NOTHING', [user.id, creator.id]);
    else await db.query('DELETE FROM follows WHERE follower_id=$1 AND creator_id=$2', [user.id, creator.id]);
    publishFeed();
    return { ok: true };
  }

  @Get('inbox')
  async inbox(@Req() req: Request) {
    const user = await requireUser(req);
    return (await db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (peer) * FROM (
          SELECT id,body,created_at,recipient_id AS peer FROM messages WHERE sender_id=$1
          UNION ALL
          SELECT id,body,created_at,sender_id AS peer FROM messages WHERE recipient_id=$1
        ) entries ORDER BY peer,created_at DESC,id DESC
      )
      SELECT u.handle,u.display_name,l.body,l.created_at FROM latest l JOIN users u ON u.id=l.peer
      ORDER BY l.created_at DESC,l.id DESC LIMIT 50`, [user.id])).rows;
  }

  @Get('inbox/:handle')
  async conversation(@Req() req: Request, @Param('handle') handle: string) {
    const user = await requireUser(req);
    const peer = await person(handle);
    const { rows } = await db.query(`
      SELECT id,body,created_at,sender_id=$1 AS mine FROM messages
      WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)
      ORDER BY created_at DESC,id DESC LIMIT 100`, [user.id, peer.id]);
    return rows.reverse();
  }

  @Post('inbox/:handle')
  @Throttle({ default: { limit: 35, ttl: 60000 } })
  async message(@Req() req: Request, @Param('handle') handle: string, @Body() body: unknown) {
    const user = await requireUser(req);
    const peer = await person(handle);
    if (user.id === peer.id) throw new BadRequestException('Choose another creator.');
    const input = parse(z.object({ body: cleanText(1000) }), body);
    await db.query('INSERT INTO messages(sender_id,recipient_id,body) VALUES($1,$2,$3)', [user.id, peer.id, input.body]);
    publishInbox(user.id, peer.id);
    return { ok: true };
  }
}
