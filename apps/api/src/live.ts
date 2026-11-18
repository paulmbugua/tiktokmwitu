import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { AccessToken, DataPacket_Kind, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { z } from 'zod';
import { cleanText, db, handleSchema, parse, requireUser, uuid, type Person } from './infra';
import { currentMatch, endMatch, lockedRoom, member, requireOpen, settle, type LiveRoom } from './live-store';

const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
const internalUrl = process.env.LIVEKIT_INTERNAL_URL || url;
const service = url && internalUrl && key && secret
  ? new RoomServiceClient(internalUrl, key, secret, { requestTimeout: 6 })
  : null;
export const roomName = (id: string) => 'mwitu-' + id;
const encoder = new TextEncoder();
const duration = 180;

export function liveService() {
  if (!service) throw new ServiceUnavailableException('Live broadcasts are unavailable.');
  return service;
}

export function notifyRoom(id: string) {
  void liveService().sendData(roomName(id), encoder.encode('changed'), DataPacket_Kind.RELIABLE, { topic: 'mwitu-room' })
    .catch(() => undefined);
}

export function publishPermission(canPublish: boolean) {
  return { canPublish, canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE], canSubscribe: true, canPublishData: false };
}

export async function connectedUser(id: string, userId: string) {
  const participants = await liveService().listParticipants(roomName(id));
  const participant = participants.find(entry => entry.identity === userId);
  if (!participant) throw new ConflictException('Connect to the LIVE room first.');
  return participant;
}

async function waitForCamera(id: string, userId: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const participant = await connectedUser(id, userId);
    if (participant.tracks.some(track => track.source === TrackSource.CAMERA)) return;
    if (attempt < 9) await delay(250);
  }
  throw new ConflictException('Start your camera first.');
}

async function grant(room: LiveRoom, user: Person) {
  const host = room.host_id === user.id;
  const token = new AccessToken(key, secret, { identity: user.id, name: user.display_name, ttl: '30s' });
  token.addGrant({ roomJoin: true, room: roomName(room.id), ...publishPermission(host) });
  return { url, token: await token.toJwt(), host, id: room.id, hostId: room.host_id, shareCode: room.share_code };
}

export async function finishRoom(id: string, outcome: string, moderator?: Person) {
  await lockedRoom(id, async (client, room) => {
    if (room.ended_at) return;
    await settle(client, room);
    await endMatch(client, room, outcome, moderator ? undefined : room.host_id);
    await client.query('UPDATE live_rooms SET ended_at=now() WHERE id=$1', [id]);
    if (moderator) {
      await client.query('DELETE FROM live_reports WHERE room_id=$1', [id]);
      await client.query(`INSERT INTO live_audit(room_id,actor_id,action,details)
        VALUES ($1,$2,'platformEnd','{}')`, [id, moderator.id]);
    }
  });
  if (service) await service.deleteRoom(roomName(id)).catch(error => console.error('LIVE disconnect will retry', id, error));
}

let ticking = false;
const hostMissing = new Map<string, number>();
const guestMissing = new Map<string, number>();

export async function reconcileLive() {
  if (!service || ticking) return;
  ticking = true;
  try {
    const { rows } = await db.query<LiveRoom>('SELECT * FROM live_rooms WHERE ended_at IS NULL');
    const rooms = new Set(rows.map(row => row.id));
    for (const id of hostMissing.keys()) if (!rooms.has(id)) hostMissing.delete(id);
    for (const id of guestMissing.keys()) if (!rooms.has(id)) guestMissing.delete(id);
    const remote = new Map((await service.listRooms()).map(room => [room.name, room]));
    const ended = [...remote.keys()].filter(name => name.startsWith('mwitu-') && !rooms.has(name.slice(6)));
    await Promise.allSettled(ended.map(name => service.deleteRoom(name)));
    await Promise.allSettled(rows.map(async room => {
      const name = roomName(room.id);
      const participants = remote.has(name) ? await service.listParticipants(name) : [];
      const hostPresent = participants.some(person => person.identity === room.host_id);
      if (hostPresent) hostMissing.delete(room.id);
      else if (!hostMissing.has(room.id)) hostMissing.set(room.id, Date.now());
      const missingSince = hostMissing.get(room.id);
      if ((!room.online_at && Date.now() - room.created_at.getTime() > 60000) ||
          (missingSince !== undefined && Date.now() - missingSince > 20000 && room.online_at)) {
        await finishRoom(room.id, 'host_left');
        return;
      }

      const changed = await lockedRoom(room.id, async (client, fresh) => {
        if (fresh.ended_at) return false;
        let updated = await settle(client, fresh);
        let match = await currentMatch(client, fresh);
        if (match?.status === 'running' && !participants.some(person => person.identity === match?.guest_id)) {
          const since = guestMissing.get(room.id) ?? Date.now();
          guestMissing.set(room.id, since);
          if (Date.now() - since > 15000) {
            await endMatch(client, fresh, 'guest_left', match.guest_id);
            match = undefined;
            updated = true;
          }
        } else guestMissing.delete(room.id);
        const banned = new Set((await client.query<{ user_id: string }>(
          'SELECT user_id FROM live_members WHERE room_id=$1 AND banned', [room.id])).rows.map(row => row.user_id));
        // The same room lock serializes role changes with the permission reconciliation.
        await Promise.allSettled(participants.map(async person => {
          if (banned.has(person.identity)) return service.removeParticipant(name, person.identity);
          const guest = match?.guest_id === person.identity && ['ready', 'running'].includes(match.status);
          if (person.identity !== fresh.host_id && person.permission?.canPublish && !guest) {
            await service.updateParticipant(name, person.identity, { permission: publishPermission(false) });
          }
        }));
        return updated;
      });
      if (changed) notifyRoom(room.id);
    }));
  } catch (error) {
    console.error('LIVE reconciliation failed', error);
  } finally {
    ticking = false;
  }
}

@Controller('live')
export class LiveController {
  @Get()
  async list() {
    if (!service) return { enabled: false, rooms: [] };
    const remote = (await service.listRooms()).filter(room => /^mwitu-[0-9a-f-]{36}$/.test(room.name));
    const counts = new Map(remote.map(room => [room.name, room.numParticipants]));
    const { rows } = await db.query(`
      SELECT r.id,u.id AS host_id,u.handle,u.display_name FROM live_rooms r JOIN users u ON u.id=r.host_id
      WHERE r.id=ANY($1::uuid[]) AND r.online_at IS NOT NULL AND r.ended_at IS NULL
      ORDER BY r.online_at DESC`, [remote.map(room => room.name.slice(6))]);
    return { enabled: true, rooms: rows.map(room => ({ ...room, viewers: Math.max(0, (counts.get(roomName(room.id)) ?? 1) - 1) })) };
  }

  @Post('start')
  @Throttle({ default: { ttl: 60000, limit: 8 } })
  async start(@Req() req: Request) {
    const user = await requireUser(req);
    liveService();
    const { rows: [room] } = await db.query<LiveRoom>(`
      INSERT INTO live_rooms(host_id) VALUES ($1)
      ON CONFLICT(host_id) WHERE ended_at IS NULL DO NOTHING RETURNING *`, [user.id]);
    if (!room) throw new ConflictException('You already have an active LIVE. Reopen it from the LIVE list.');
    return grant(room, user);
  }

  @Get('handoff/:code')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async handoff(@Param('code') raw: string) {
    liveService();
    const code = parse(z.string().trim().toUpperCase().regex(/^[0-9A-F]{12}$/, 'Enter the 12-character LIVE code.'), raw);
    const { rows: [match] } = await db.query<{ id: string; host_id: string; handle: string; display_name: string }>(`
      SELECT r.id,r.host_id,u.handle,u.display_name FROM live_rooms r JOIN users u ON u.id=r.host_id
      WHERE r.share_code=$1 AND r.online_at IS NOT NULL AND r.ended_at IS NULL`, [code]);
    if (!match) throw new NotFoundException('This LIVE code is invalid or the broadcast has ended.');
    const [room] = await liveService().listRooms([roomName(match.id)]);
    if (!room) throw new NotFoundException('This LIVE is no longer available.');
    const participants = await liveService().listParticipants(room.name);
    if (!participants.some(person => person.identity === match.host_id)) throw new NotFoundException('This LIVE is no longer available.');
    return { id: match.id, handle: match.handle, display_name: match.display_name };
  }

  @Post(':id/join')
  async join(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    liveService();
    return lockedRoom(uuid(raw), async (client, room) => {
      requireOpen(room);
      await member(client, room, user);
      await client.query(`
        INSERT INTO live_members(room_id,user_id,joined_at) VALUES ($1,$2,now())
        ON CONFLICT(room_id,user_id) DO UPDATE SET joined_at=now()`, [room.id, user.id]);
      return grant(room, user);
    });
  }

  @Post(':id/online')
  async online(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    const id = uuid(raw);
    await waitForCamera(id, user.id);
    await lockedRoom(id, async (client, room) => {
      if (room.host_id !== user.id || room.ended_at) throw new ForbiddenException();
      await client.query('UPDATE live_rooms SET online_at=COALESCE(online_at,now()) WHERE id=$1', [id]);
    });
    return { ok: true };
  }

  @Post(':id/end')
  async end(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const { rows: [room] } = await db.query<LiveRoom>('SELECT * FROM live_rooms WHERE id=$1', [id]);
    if (room?.host_id !== user.id) throw new ForbiddenException();
    await finishRoom(id, 'host_left').catch(async error => {
      const { rowCount } = await db.query('SELECT 1 FROM live_rooms WHERE id=$1 AND ended_at IS NOT NULL', [id]);
      if (!rowCount) throw error;
    });
    return { ok: true };
  }

  @Get(':id/state')
  async state(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    return lockedRoom(uuid(raw), async (client, room) => {
      const self = await member(client, room, user);
      await settle(client, room);
      const { rows: [match] } = await client.query(`
        SELECT m.id,m.guest_id,m.status,m.starts_at,m.ends_at,m.expires_at,m.host_score,m.guest_score,m.winner_id,m.outcome,
          u.display_name AS guest_name, (SELECT side FROM live_votes WHERE match_id=m.id AND user_id=$2) AS voted
        FROM live_matches m JOIN users u ON u.id=m.guest_id WHERE m.room_id=$1
        ORDER BY m.updated_at DESC,m.id DESC LIMIT 1`, [room.id, user.id]);
      const { rows: messages } = await client.query(`
        SELECT m.id,m.user_id,m.body,u.handle FROM live_messages m JOIN users u ON u.id=m.user_id
        WHERE m.room_id=$1 AND m.deleted_at IS NULL ORDER BY (m.id=$2) DESC NULLS LAST,m.created_at DESC,m.id DESC LIMIT 60`,
        [room.id, room.pinned_id]);
      return {
        self, room: { id: room.id, host_id: room.host_id, ended: !!room.ended_at, chat_open: room.chat_open, pinned_id: room.pinned_id },
        match, messages: messages.reverse(), now: Date.now(),
      };
    });
  }

  @Post(':id/chat')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async chat(@Req() req: Request, @Param('id') raw: string, @Body() input: unknown) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const { body } = parse(z.object({ body: cleanText(300) }), input);
    await connectedUser(id, user.id);
    await lockedRoom(id, async (client, room) => {
      requireOpen(room);
      const self = await member(client, room, user);
      if (self.role === 'viewer' && (!room.chat_open || (self.mutedUntil && self.mutedUntil > new Date()))) {
        throw new ForbiddenException('You cannot send chat messages right now.');
      }
      const normalized = body.normalize('NFKC').toLowerCase();
      if (room.keywords.some(word => normalized.includes(word))) throw new ForbiddenException('This message contains a blocked keyword.');
      await client.query('INSERT INTO live_messages(room_id,user_id,body) VALUES ($1,$2,$3)', [id, user.id, body]);
    });
    notifyRoom(id);
    return { ok: true };
  }

  @Post(':id/match')
  @Throttle({ default: { ttl: 60000, limit: 40 } })
  async match(@Req() req: Request, @Param('id') raw: string, @Body() input: unknown) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const command = parse(z.discriminatedUnion('action', [
      z.object({ action: z.literal('invite'), handle: handleSchema }),
      z.object({ action: z.enum(['accept', 'decline', 'cancel', 'restore', 'ready', 'forfeit']), matchId: z.uuid() }),
      z.object({ action: z.literal('vote'), matchId: z.uuid(), side: z.enum(['host', 'guest']) }),
    ]), input);
    await connectedUser(id, user.id);
    if (command.action === 'ready') await waitForCamera(id, user.id);
    const result = await lockedRoom(id, async (client, room) => {
      requireOpen(room);
      await member(client, room, user);
      await settle(client, room);
      const host = room.host_id === user.id;
      const match = await currentMatch(client, room);

      if (command.action === 'invite') {
        if (!host) throw new ForbiddenException('Only the host can invite a challenger.');
        if (match) throw new ConflictException('Finish the current invite or match first.');
        const { rows: [guest] } = await client.query<Person>('SELECT id,handle,display_name FROM users WHERE handle=$1', [command.handle]);
        if (!guest || guest.id === user.id) throw new NotFoundException('Choose another Tiktok mwitu account.');
        await member(client, room, guest);
        await client.query(`INSERT INTO live_matches(room_id,guest_id,status,expires_at)
          VALUES ($1,$2,'invited',clock_timestamp()+interval '5 minutes')`, [id, guest.id]);
        return { ok: true };
      }

      if (!match || match.id !== command.matchId) return { ok: false, message: 'This match is no longer available.' };
      const guest = user.id === match.guest_id;

      switch (command.action) {
        case 'accept':
          if (!guest || match.status !== 'invited') throw new ForbiddenException();
          await liveService().updateParticipant(roomName(id), user.id, { permission: publishPermission(true) });
          await client.query("UPDATE live_matches SET status='ready',expires_at=now()+interval '45 seconds',updated_at=now() WHERE id=$1", [match.id]);
          break;
        case 'restore':
          if (!guest || !['ready', 'running'].includes(match.status)) throw new ForbiddenException();
          await liveService().updateParticipant(roomName(id), user.id, { permission: publishPermission(true) });
          break;
        case 'ready': {
          if (!guest || match.status !== 'ready') throw new ForbiddenException();
          await client.query(`
            UPDATE live_matches SET status='running',starts_at=clock_timestamp()+interval '5 seconds',
              ends_at=clock_timestamp()+make_interval(secs=>$2 + 5),updated_at=now() WHERE id=$1`, [match.id, duration]);
          break;
        }
        case 'decline':
          if (!guest || !['invited','ready'].includes(match.status)) throw new ForbiddenException();
          await endMatch(client, room, 'declined');
          break;
        case 'cancel':
          if (!host || match.status === 'running') throw new ForbiddenException();
          await endMatch(client, room, 'cancelled');
          break;
        case 'forfeit':
          if ((!host && !guest) || match.status !== 'running') throw new ForbiddenException();
          await endMatch(client, room, 'forfeit', user.id);
          break;
        case 'vote': {
          if (host || guest) throw new ForbiddenException('Contestants cannot score their own match.');
          if (match.status !== 'running' || Date.now() < match.starts_at!.getTime()) {
            throw new ConflictException('Voting opens after the countdown.');
          }
          const { rowCount } = await client.query(`
            INSERT INTO live_votes(match_id,user_id,side)
            SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM live_matches WHERE id=$1 AND ends_at>clock_timestamp())
            ON CONFLICT DO NOTHING`, [match.id, user.id, command.side]);
          if (!rowCount) return { ok: false, message: 'Voting is closed or you already voted.' };
          const column = command.side === 'host' ? 'host_score' : 'guest_score';
          await client.query('UPDATE live_matches SET ' + column + '=' + column + '+1 WHERE id=$1', [match.id]);
          break;
        }
      }
      return { ok: true };
    });
    notifyRoom(id);
    if (!result.ok) throw new ConflictException(result.message);
    return result;
  }
}
