import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { AccessToken, DataPacket_Kind, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { z } from 'zod';
import { cleanText, cookie, db, handleSchema, identity, parse, requireUser, uuid, type Person } from './infra';
import { currentMatch, endMatch, lockedRoom, matchGuests, member, requireOpen, settle, stageSnapshot, type LiveRoom } from './live-store';
import { recentGifts } from './gift-store';
import { browserKey } from './commerce';
import { checkInvite, claimInvite, isAudienceCode, normalizeInvite, type InvitePass } from './live-invites';
import { enqueueStream, playback, streamEnabled, type StreamSource } from './live-stream';
import { activePlanSql, audienceBalance, liveLikeMinimumViewers, liveLikeTarget, maxLiveMinutes, meterLive, requireAudienceBalance } from './live-pricing';

const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
const internalUrl = process.env.LIVEKIT_INTERNAL_URL || url;
const service = url && internalUrl && key && secret
  ? new RoomServiceClient(internalUrl, key, secret, { requestTimeout: 6 })
  : null;
export const roomName = (id: string) => 'mwitu-' + id;
const encoder = new TextEncoder();
export const guestIdentityPrefix = 'guest:';
const minimumFollowers = 200;
const likeWindowMs = 6 * 60_000;
function likeGoal(room: LiveRoom) {
  return { total: room.like_total, count: room.like_total - room.like_baseline, target: liveLikeTarget,
    endsAt: room.like_started_at ? room.like_started_at.getTime() + likeWindowMs : null };
}
const hostingEligibility = `
  SELECT (SELECT count(*)::int FROM follows WHERE creator_id=$1) AS followers,
    EXISTS (SELECT 1 FROM live_invite_plans WHERE user_id=$1 AND ends_at>statement_timestamp()) AS "hasActivePlan"`;
type HostingEligibility = { followers: number; hasActivePlan: boolean };

async function roomMessages(client: PoolClient | typeof db, room: LiveRoom, guest = false) {
  const { rows } = await client.query(`
    SELECT id,user_id,body,handle FROM (
      SELECT m.id,m.user_id,m.body,u.handle,m.created_at
      FROM live_messages m JOIN users u ON u.id=m.user_id
      WHERE m.room_id=$1 AND m.deleted_at IS NULL
      ORDER BY (m.id=$2) DESC NULLS LAST,m.created_at DESC,m.id DESC LIMIT 60
    ) recent ORDER BY created_at,id`, [room.id, room.pinned_id]);
  return guest ? rows.map(({ id, body, handle }) => ({ id, body, handle })) : rows;
}

async function loadBroadcast(id: string) {
  const { rows: [room] } = await db.query<LiveRoom & StreamSource & { available: boolean }>(`
    SELECT r.*,r.id AS room_id,s.input_id,s.provider,s.available FROM live_rooms r
    LEFT JOIN live_streams s ON s.room_id=r.id WHERE r.id=$1`, [id]);
  if (!room) throw new NotFoundException('Broadcast not found.');
  const [matchResult, stage, messages, gifts] = await Promise.all([
    db.query<{ id: string }>(`SELECT m.id,m.guest_id,m.status,m.starts_at,m.ends_at,m.expires_at,m.host_score,m.guest_score,
      m.winner_id,m.outcome,u.display_name AS guest_name FROM live_matches m JOIN users u ON u.id=m.guest_id
      WHERE m.room_id=$1 ORDER BY m.updated_at DESC,m.id DESC LIMIT 1`, [id]),
    stageSnapshot(db, room, null),
    room.ended_at ? [] : roomMessages(db, room, true),
    room.ended_at ? [] : recentGifts(db, id),
  ]);
  const [match] = matchResult.rows;
  return {
    room: { id, ended: !!room.ended_at, endedReason: room.end_reason, endsAt: room.deadline_at,
      guest_access: room.guest_access, chat_open: room.chat_open, pinned_id: room.pinned_id },
    playback: !room.ended_at && room.available ? playback(room) : null,
    likes: likeGoal(room),
    stage, match: match ? { ...match, guests: await matchGuests(db, match.id) } : undefined,
    messages, gifts, now: Date.now(),
  };
}

const broadcastCache = new Map<string, { expires: number; result: ReturnType<typeof loadBroadcast> }>();
function broadcastSnapshot(id: string) {
  const cached = broadcastCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (broadcastCache.size > 512) broadcastCache.clear();
  const result = loadBroadcast(id);
  broadcastCache.set(id, { expires: Date.now() + 1200, result });
  void result.catch(() => {
    if (broadcastCache.get(id)?.result === result) broadcastCache.delete(id);
  });
  return result;
}

function guestBroadcast(shared: Awaited<ReturnType<typeof loadBroadcast>>) {
  const room = { ...shared.room, chat_open: false };
  const self = { role: 'guest', mutedUntil: null };
  if (!room.guest_access || room.ended) return { room, self, messages: [], now: Date.now() };
  return { ...shared, room, self };
}

const guestFeeds = new Map<string, Set<Response>>();
const guestFeedViewers = new WeakMap<Response, string>();
const streamingViewers = new Map<string, Map<string, number>>();
function streamingPresence(room: LiveRoom, viewer: string) {
  if (!room.invite_plan_id || room.ended_at) return;
  const viewers = streamingViewers.get(room.id) ?? new Map<string, number>();
  viewers.set(viewer, Date.now() + 18000);
  streamingViewers.set(room.id, viewers);
}

function addStreamingAudience(room: LiveRoom, stage: Set<string>, viewers: Set<string>) {
  const now = Date.now();
  const recent = streamingViewers.get(room.id);
  for (const [viewer, expiresAt] of recent ?? []) {
    if (expiresAt <= now) recent?.delete(viewer);
    else if (!stage.has(viewer) && (room.guest_access || !viewer.startsWith(guestIdentityPrefix))) viewers.add(viewer);
  }
  if (room.guest_access) {
    for (const feed of guestFeeds.get(room.id) ?? []) {
      const viewer = guestFeedViewers.get(feed);
      if (viewer && !feed.destroyed) viewers.add(viewer);
    }
  }
}
export const streamGuestCount = (id: string) => guestFeeds.get(id)?.size ?? 0;
const lastGuestEvent = new Map<string, { revision: string; sentAt: number }>();
let pushingGuests = false;
export async function pushGuestBroadcasts() {
  if (pushingGuests || !guestFeeds.size) return;
  pushingGuests = true;
  try {
    await Promise.allSettled([...guestFeeds].map(async ([id, responses]) => {
      const snapshot = guestBroadcast(await broadcastSnapshot(id));
      if (guestFeeds.get(id) !== responses) return;
      const { now, ...visible } = snapshot;
      const revision = JSON.stringify(visible);
      const previous = lastGuestEvent.get(id);
      const changed = previous?.revision !== revision;
      if (!changed && Date.now() - previous.sentAt < 15000) return;
      lastGuestEvent.set(id, { revision, sentAt: Date.now() });
      const frame = changed ? 'data: ' + JSON.stringify({ ...visible, now }) + '\n\n' : ': keepalive\n\n';
      for (const response of responses) {
        if (response.destroyed || response.writableLength > 65536) response.destroy();
        else {
          response.write(frame);
          if (visible.room.ended || !visible.room.guest_access) response.end();
        }
      }
    }));
  } finally { pushingGuests = false; }
}

async function handoffRoom(raw: string) {
  const code = normalizeInvite(raw);
  const { rows: [room] } = await db.query<LiveRoom & InvitePass & { handle: string; display_name: string }>(`
    SELECT r.*,p.code,p.expires_at,p.claim_browser,p.claim_user,p.room_id,u.handle,u.display_name
    FROM live_invite_passes p JOIN live_rooms r ON r.id=p.room_id JOIN users u ON u.id=r.host_id
    WHERE p.code=$1 AND r.online_at IS NOT NULL`, [code]);
  if (!room) throw new NotFoundException('This LIVE code is invalid or the broadcast has ended.');
  return room;
}

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

export async function joinedAudience(client: PoolClient | typeof db, id: string, userId: string) {
  return !!(await client.query(`
    SELECT 1 FROM live_members m JOIN live_streams s ON s.room_id=m.room_id
    WHERE m.room_id=$1 AND m.user_id=$2 AND NOT m.banned AND m.joined_at>now()-interval '2 minutes'`,
    [id, userId])).rowCount;
}

async function waitForCamera(id: string, userId: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const participant = await connectedUser(id, userId);
    if (participant.tracks.some(track => track.source === TrackSource.CAMERA)) return;
    if (attempt < 9) await delay(250);
  }
  throw new ConflictException('Start your camera first.');
}

async function grant(room: LiveRoom, user: Pick<Person, 'id' | 'display_name'>, guest = false, shareCode?: string, audience = false) {
  const host = !guest && room.host_id === user.id;
  const info = { host, guest, id: room.id, hostId: room.host_id, shareCode };
  if (audience && !host) return { ...info, transport: 'stream' as const };
  const token = new AccessToken(key, secret, { identity: user.id, name: user.display_name, ttl: '30s' });
  token.addGrant({ roomJoin: true, room: roomName(room.id), ...publishPermission(host) });
  return { ...info, transport: 'livekit' as const, url, token: await token.toJwt() };
}

async function streamRoom(id: string) {
  if (!streamEnabled) return false;
  return !!(await db.query('SELECT 1 FROM live_streams WHERE room_id=$1', [id])).rowCount;
}

async function joinAudience(room: LiveRoom, user: Person) {
  requireOpen(room);
  await member(db, room, user);
  const saved = await db.query(`
    INSERT INTO live_members(room_id,user_id,joined_at)
    SELECT id,$2,now() FROM live_rooms WHERE id=$1 AND online_at IS NOT NULL AND ended_at IS NULL
    ON CONFLICT(room_id,user_id) DO UPDATE SET joined_at=now() WHERE NOT live_members.banned
    RETURNING user_id`, [room.id, user.id]);
  if (!saved.rowCount) throw new ForbiddenException('This LIVE is unavailable.');
}

export async function finishRoom(id: string, outcome: string, moderator?: Person) {
  const ended = await lockedRoom(id, async (client, room) => {
    if (room.ended_at) return true;
    if (outcome === 'like_goal' && (!room.like_started_at ||
        Date.now() < room.like_started_at.getTime() + likeWindowMs || likeGoal(room).count >= liveLikeTarget)) return false;
    if (room.invite_plan_id && room.online_at) {
      const budget = await meterLive(client, id, room.invite_plan_id, 0);
      if (outcome === 'audience_limit' && budget !== 'audience_limit' && budget !== 'plan_expired') return false;
    }
    await settle(client, room);
    await endMatch(client, room, outcome, !moderator && outcome === 'host_left' ? room.host_id : undefined);
    await client.query('DELETE FROM live_stage_seats WHERE room_id=$1', [id]);
    await client.query('DELETE FROM live_stage_requests WHERE room_id=$1', [id]);
    await client.query('DELETE FROM live_like_batches WHERE room_id=$1', [id]);
    await client.query('UPDATE live_rooms SET ended_at=now(),end_reason=$2,spotlight_id=NULL,spotlight_fullscreen=false WHERE id=$1', [id, outcome]);
    await client.query("UPDATE live_streams SET available=false,checked_at='-infinity' WHERE room_id=$1", [id]);
    if (moderator) {
      await client.query('DELETE FROM live_reports WHERE room_id=$1', [id]);
      await client.query(`INSERT INTO live_audit(room_id,actor_id,action,details)
        VALUES ($1,$2,'platformEnd','{}')`, [id, moderator.id]);
    }
    return true;
  });
  if (!ended) return;
  streamingViewers.delete(id);
  broadcastCache.delete(id);
  if (service) await service.deleteRoom(roomName(id)).catch(error => console.error('LIVE disconnect will retry', id, error));
}

let ticking = false;
const hostMissing = new Map<string, number>();
const guestMissing = new Map<string, { matchId:string; userId:string; since:number }>();

export async function reconcileLive() {
  if (!service || ticking) return;
  ticking = true;
  try {
    const { rows } = await db.query<LiveRoom>('SELECT * FROM live_rooms WHERE ended_at IS NULL');
    const rooms = new Set(rows.map(row => row.id));
    const due = rows.filter(room => room.deadline_at && room.deadline_at <= new Date());
    await Promise.allSettled(due.map(room => finishRoom(room.id, 'duration_limit')));
    for (const id of hostMissing.keys()) if (!rooms.has(id)) hostMissing.delete(id);
    for (const id of guestMissing.keys()) if (!rooms.has(id)) guestMissing.delete(id);
    const remote = new Map((await service.listRooms()).map(room => [room.name, room]));
    const ended = [...remote.keys()].filter(name => name.startsWith('mwitu-') && !rooms.has(name.slice(6)));
    await Promise.allSettled(ended.map(name => service.deleteRoom(name)));
    await Promise.allSettled(rows.map(async room => {
      const name = roomName(room.id);
      const changed = await lockedRoom(room.id, async (client, fresh) => {
        if (fresh.ended_at) return false;
        const participants = remote.has(name) ? await service.listParticipants(name) : [];
        if (fresh.online_at) {
          const stage = new Set(participants.filter(person =>
            person.identity === fresh.host_id || person.permission?.canPublish || person.permission?.hidden).map(person => person.identity));
          const { rows: [stream] } = await client.query<{ available: boolean }>(
            'SELECT available FROM live_streams WHERE room_id=$1', [fresh.id]);
          const viewers = new Set(participants.filter(person => !stage.has(person.identity) &&
            (fresh.guest_access || !person.identity.startsWith(guestIdentityPrefix))).map(person => person.identity));
          if (stream?.available) addStreamingAudience(fresh, stage, viewers);
          if (fresh.invite_plan_id) {
            const limit = await meterLive(client, fresh.id, fresh.invite_plan_id, viewers.size);
            if (limit) return limit;
          }
          if (viewers.size < liveLikeMinimumViewers && fresh.like_started_at) {
            await client.query('UPDATE live_rooms SET like_started_at=NULL,like_baseline=like_total WHERE id=$1', [fresh.id]);
          } else if (viewers.size >= liveLikeMinimumViewers && participants.some(person => person.identity === fresh.host_id)) {
            const goal = likeGoal(fresh);
            if (goal.endsAt && goal.endsAt <= Date.now() && goal.count < goal.target) return 'like_goal';
            if (!goal.endsAt || goal.endsAt <= Date.now()) {
              await client.query('UPDATE live_rooms SET like_started_at=now(),like_baseline=like_total WHERE id=$1', [fresh.id]);
            }
          }
        }
        const connected = participants.map(person => person.identity);
        if (connected.includes(fresh.host_id)) hostMissing.delete(fresh.id);
        else if (!hostMissing.has(fresh.id)) hostMissing.set(fresh.id, Date.now());
        const missingSince = hostMissing.get(fresh.id);
        if ((!fresh.online_at && Date.now() - fresh.created_at.getTime() > 60000) ||
            (missingSince !== undefined && Date.now() - missingSince > 20000 && fresh.online_at)) return 'host_left';

        let updated = await settle(client, fresh);
        let match = await currentMatch(client, fresh);
        const roster=match?await matchGuests(client,match.id):[];
        const battleGuests=roster.length ? roster.filter(person=>person.status!=='invited').map(person=>person.user_id)
          : match&&['ready','running'].includes(match.status)?[match.guest_id]:[];
        const missing=match?.status==='running'?battleGuests.find(userId=>!connected.includes(userId)):undefined;
        if (match && missing) {
          const previous=guestMissing.get(room.id);
          const since = previous?.matchId===match.id&&previous.userId===missing ? previous.since : Date.now();
          guestMissing.set(room.id, {matchId:match.id,userId:missing,since});
          if (Date.now() - since > 15000) {
            await endMatch(client, fresh, 'guest_left', missing);
            match = undefined;
            updated = true;
          }
        } else guestMissing.delete(room.id);
        await client.query(`
          UPDATE live_stage_seats SET missing_since=CASE WHEN user_id::text=ANY($2::text[]) THEN NULL ELSE now() END
          WHERE room_id=$1 AND accepted_at IS NOT NULL AND (missing_since IS NULL)<> (user_id::text=ANY($2::text[]))`, [room.id, connected]);
        const { rows: expired } = await client.query<{ user_id: string }>(`
          DELETE FROM live_stage_seats WHERE room_id=$1 AND
            ((accepted_at IS NULL AND expires_at<=now()) OR missing_since<=now()-interval '25 seconds')
          RETURNING user_id`, [room.id]);
        if (expired.length) {
          await client.query('UPDATE live_rooms SET spotlight_id=NULL,spotlight_fullscreen=false WHERE id=$1 AND spotlight_id=ANY($2::uuid[])',
            [room.id, expired.map(seat => seat.user_id)]);
          updated = true;
        }
        const stage = new Set((await client.query<{ user_id: string }>(
          'SELECT user_id FROM live_stage_seats WHERE room_id=$1 AND accepted_at IS NOT NULL', [room.id])).rows.map(row => row.user_id));
        const banned = new Set((await client.query<{ user_id: string }>(
          'SELECT user_id FROM live_members WHERE room_id=$1 AND banned', [room.id])).rows.map(row => row.user_id));
        // The same room lock serializes role changes with the permission reconciliation.
        await Promise.allSettled(participants.map(async person => {
          if (banned.has(person.identity) || (!fresh.guest_access && person.identity.startsWith(guestIdentityPrefix))) {
            return service.removeParticipant(name, person.identity);
          }
          const guest = match && battleGuests.includes(person.identity) && ['ready', 'running'].includes(match.status);
          if (person.identity !== fresh.host_id && person.permission?.canPublish && !guest && !stage.has(person.identity)) {
            await service.updateParticipant(name, person.identity, { permission: publishPermission(false) });
          }
        }));
        return updated;
      });
      if (typeof changed === 'string') await finishRoom(room.id, changed);
      else if (changed) notifyRoom(room.id);
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
      SELECT r.id,u.id AS host_id,u.handle,u.display_name,
        CASE WHEN s.room_id IS NOT NULL THEN (SELECT count(*)::int FROM live_members m
          WHERE m.room_id=r.id AND m.user_id<>r.host_id AND NOT m.banned AND m.joined_at>now()-interval '2 minutes') END AS audience
      FROM live_rooms r JOIN users u ON u.id=r.host_id LEFT JOIN live_streams s ON s.room_id=r.id
      WHERE r.id=ANY($1::uuid[]) AND r.online_at IS NOT NULL AND r.ended_at IS NULL
      ORDER BY r.online_at DESC`, [remote.map(room => room.name.slice(6))]);
    return { enabled: true, rooms: rows.map(({ audience, ...room }) => ({ ...room, viewers: audience === null
      ? Math.max(0, (counts.get(roomName(room.id)) ?? 1) - 1) : audience + streamGuestCount(room.id) })) };
  }

  @Get('eligibility')
  async eligibility(@Req() req: Request) {
    const user = await requireUser(req);
    const { rows: [status] } = await db.query<HostingEligibility>(hostingEligibility, [user.id]);
    return { ...status, minimumFollowers, canStart: status.hasActivePlan || status.followers >= minimumFollowers };
  }

  @Post('start')
  @Throttle({ default: { ttl: 60000, limit: 8 } })
  async start(@Req() req: Request) {
    const user = await requireUser(req);
    liveService();
    const { rows: [plan] } = await db.query<{id: string}>(activePlanSql, [user.id]);
    await requireAudienceBalance(db, plan?.id ?? null);
    const { rows: [{ eligible, room }] } = await db.query<{ eligible: boolean; room: LiveRoom | null }>(`
      WITH status AS (${hostingEligibility}), eligibility AS (
        SELECT followers >= $2 OR "hasActivePlan" AS eligible FROM status
      ), started AS (
        INSERT INTO live_rooms(host_id,invite_plan_id) SELECT $1,$3 FROM eligibility WHERE eligible
        ON CONFLICT(host_id) WHERE ended_at IS NULL DO NOTHING RETURNING *
      )
      SELECT eligible, (SELECT row_to_json(started) FROM started) AS room FROM eligibility`,
      [user.id, minimumFollowers, plan?.id ?? null]);
    if (!eligible) throw new ForbiddenException(`You need ${minimumFollowers} followers or an active weekly LIVE invite plan to start a broadcast.`);
    if (!room) throw new ConflictException('You already have an active LIVE. Reopen it from the LIVE list.');
    return grant(room, user);
  }

  @Get('handoff/:code')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async handoff(@Param('code') raw: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    liveService();
    const match = await handoffRoom(raw);
    checkInvite(match, browserKey(req, res), (await identity(req.cookies[cookie]))?.id);
    if (match.ended_at) throw new NotFoundException('This LIVE code is invalid or the broadcast has ended.');
    if (await streamRoom(match.id)) return { id: match.id, handle: match.handle, display_name: match.display_name, guestAccess: match.guest_access };
    const [room] = await liveService().listRooms([roomName(match.id)]);
    if (!room) throw new NotFoundException('This LIVE is no longer available.');
    const participants = await liveService().listParticipants(room.name);
    if (!participants.some(person => person.identity === match.host_id)) throw new NotFoundException('This LIVE is no longer available.');
    return { id: match.id, handle: match.handle, display_name: match.display_name, guestAccess: match.guest_access };
  }

  @Post('handoff/:code/watch')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async watch(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('code') raw: string) {
    liveService();
    const room = await handoffRoom(raw);
    if (await streamRoom(room.id)) {
      requireOpen(room);
      const user = await identity(req.cookies[cookie]);
      if (user) await member(db, room, user);
      if (!room.guest_access) throw new ForbiddenException('The host has turned off guest watching.');
      const browser = browserKey(req, res);
      checkInvite(room, browser);
      if (isAudienceCode(room.code)) {
        await db.query('INSERT INTO live_invite_viewers(code,browser_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [room.code, browser]);
      } else {
        await lockedRoom(room.id, async (client, fresh) => {
          requireOpen(fresh);
          if (!fresh.guest_access) throw new ForbiddenException('The host has turned off guest watching.');
          await claimInvite(client, room.code, room.id, browser, user?.id);
        });
      }
      return grant(room, { id: guestIdentityPrefix + browser, display_name: 'Guest viewer' }, true, room.code, true);
    }
    await connectedUser(room.id, room.host_id);
    const user = await identity(req.cookies[cookie]);
    return lockedRoom(room.id, async (client, fresh) => {
      requireOpen(fresh);
      if (user) await member(client, fresh, user);
      if (!fresh.guest_access) throw new ForbiddenException('The host has turned off guest watching.');
      const browser=browserKey(req,res);
      await claimInvite(client, room.code, room.id, browser, isAudienceCode(room.code)?undefined:user?.id);
      return grant(fresh, { id: guestIdentityPrefix + (isAudienceCode(room.code)?browser:randomUUID()), display_name: 'Guest viewer' }, true, room.code);
    });
  }

  @Post('handoff/:code/join')
  async joinInvite(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('code') raw: string) {
    const user = await requireUser(req);
    const room = await handoffRoom(raw);
    if (await streamRoom(room.id)) {
      const browser = browserKey(req, res);
      checkInvite(room, browser, user.id);
      if (!isAudienceCode(room.code)) await lockedRoom(room.id, async (client, fresh) => {
        requireOpen(fresh);
        await member(client, fresh, user);
        await claimInvite(client, room.code, room.id, browser, user.id);
      });
      await joinAudience(room, user);
      return grant(room, user, false, room.code, true);
    }
    await connectedUser(room.id, room.host_id);
    return lockedRoom(room.id, async (client, fresh) => {
      requireOpen(fresh);
      await member(client, fresh, user);
      await claimInvite(client, room.code, room.id, browserKey(req, res), user.id);
      await client.query(`INSERT INTO live_members(room_id,user_id,joined_at) VALUES($1,$2,now())
        ON CONFLICT(room_id,user_id) DO UPDATE SET joined_at=now()`, [room.id, user.id]);
      return grant(fresh, user, false, room.code);
    });
  }

  @Get('handoff/:code/state')
  async guestState(@Param('code') raw: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const room = await handoffRoom(raw);
    const browser=browserKey(req,res);
    if(isAudienceCode(room.code)){
      if(!(await db.query('SELECT 1 FROM live_invite_viewers WHERE code=$1 AND browser_key=$2',[room.code,browser])).rowCount)
        throw new ForbiddenException('Join with this invite to continue.');
    }else{
      if (!room.claim_browser) throw new ForbiddenException('Join with this invite to continue.');
      checkInvite(room, browser, (await identity(req.cookies[cookie]))?.id);
    }
    if (await streamRoom(room.id)) {
      const shared = await broadcastSnapshot(room.id);
      if (room.guest_access && shared.playback) streamingPresence(room, guestIdentityPrefix + browser);
      return guestBroadcast({ ...shared, room: { ...shared.room, guest_access: room.guest_access && shared.room.guest_access } });
    }
    return lockedRoom(room.id, async (client, fresh) => {
      const { rows: [match] } = await client.query(`
        SELECT m.id,m.guest_id,m.status,m.starts_at,m.ends_at,m.host_score,m.guest_score,m.winner_id,m.outcome,
          u.display_name AS guest_name
        FROM live_matches m JOIN users u ON u.id=m.guest_id
        WHERE m.room_id=$1 AND m.status IN ('ready','running','finished')
          AND m.id=(SELECT id FROM live_matches WHERE room_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 1)`,
        [fresh.id]);
      return {
        self: { role: 'guest', mutedUntil: null },
        likes: likeGoal(fresh),
        room: { id: fresh.id, ended: !!fresh.ended_at, endedReason: fresh.end_reason, endsAt: fresh.deadline_at,
          guest_access: fresh.guest_access, chat_open: false,
          pinned_id: fresh.guest_access ? fresh.pinned_id : null },
        match: fresh.guest_access && match ? {...match, guests:await matchGuests(client,match.id)} : undefined,
        stage: fresh.guest_access ? await stageSnapshot(client, fresh, null) : undefined,
        messages: fresh.guest_access && !fresh.ended_at ? await roomMessages(client, fresh, true) : [],
        gifts: fresh.guest_access ? await recentGifts(client, fresh.id) : [], now: Date.now(),
      };
    });
  }

  @Get('handoff/:code/events')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async events(@Param('code') raw: string, @Req() req: Request, @Res() res: Response) {
    const room = await handoffRoom(raw);
    if (!isAudienceCode(room.code) || !await streamRoom(room.id)) throw new NotFoundException();
    const browser = browserKey(req, res);
    if (!(await db.query('SELECT 1 FROM live_invite_viewers WHERE code=$1 AND browser_key=$2', [room.code, browser])).rowCount) {
      throw new ForbiddenException('Join with this invite to continue.');
    }
    const shared = await broadcastSnapshot(room.id);
    const snapshot = guestBroadcast({ ...shared, room: { ...shared.room, guest_access: room.guest_access && shared.room.guest_access } });
    if (res.destroyed) return;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\ndata: ' + JSON.stringify(snapshot) + '\n\n');
    if (snapshot.room.ended || !snapshot.room.guest_access) { res.end(); return; }
    const responses = guestFeeds.get(room.id) ?? new Set<Response>();
    guestFeeds.set(room.id, responses);
    responses.add(res);
    guestFeedViewers.set(res, guestIdentityPrefix + browser);
    res.once('close', () => {
      responses.delete(res);
      if (!responses.size) {
        guestFeeds.delete(room.id);
        lastGuestEvent.delete(room.id);
      }
    });
  }

  @Post(':id/join')
  async join(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    liveService();
    const id = uuid(raw);
    if (await streamRoom(id)) {
      const { rows: [room] } = await db.query<LiveRoom>('SELECT * FROM live_rooms WHERE id=$1', [id]);
      if (!room) throw new NotFoundException('Broadcast not found.');
      await joinAudience(room, user);
      return grant(room, user, false, undefined, true);
    }
    return lockedRoom(id, async (client, room) => {
      requireOpen(room);
      await member(client, room, user);
      await client.query(`
        INSERT INTO live_members(room_id,user_id,joined_at) VALUES ($1,$2,now())
        ON CONFLICT(room_id,user_id) DO UPDATE SET joined_at=now()`, [room.id, user.id]);
      return grant(room, user);
    });
  }

  @Post(':id/stage-connection')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  async stageConnection(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    return lockedRoom(uuid(raw), async (client, room) => {
      requireOpen(room);
      await member(client, room, user);
      const match = await currentMatch(client, room);
      const invited = match && (match.guest_id === user.id || (await matchGuests(client, match.id)).some(guest => guest.user_id === user.id));
      const seat = await client.query(`SELECT 1 FROM live_stage_seats WHERE room_id=$1 AND user_id=$2
        AND (accepted_at IS NOT NULL OR expires_at>now())`, [room.id, user.id]);
      if (room.host_id !== user.id && !invited && !seat.rowCount) throw new ForbiddenException('A stage invitation is required.');
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
      await requireAudienceBalance(client, room.invite_plan_id);
      await client.query(`UPDATE live_rooms SET online_at=COALESCE(online_at,now()),
        deadline_at=COALESCE(deadline_at,COALESCE(online_at,now())+make_interval(mins=>$2))
        WHERE id=$1`, [id, maxLiveMinutes]);
      if (room.invite_plan_id) await enqueueStream(client, id);
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
    const id = uuid(raw);
    if (await streamRoom(id)) {
      const shared = await broadcastSnapshot(id);
      const { rows: [room] } = await db.query<LiveRoom>('SELECT * FROM live_rooms WHERE id=$1', [id]);
      if (!room) throw new NotFoundException('Broadcast not found.');
      if (room.host_id !== user.id) {
        const self = await member(db, room, user);
        if (!room.ended_at && !(await db.query('SELECT 1 FROM live_members WHERE room_id=$1 AND user_id=$2', [id, user.id])).rowCount) {
          throw new ForbiddenException('Join this LIVE to continue.');
        }
        if (shared.playback) streamingPresence(room, user.id);
        await db.query(`UPDATE live_members SET joined_at=now()
          WHERE room_id=$1 AND user_id=$2 AND NOT banned AND joined_at<now()-interval '40 seconds'`, [id, user.id]);
        const [profile, stage, vote] = await Promise.all([
          db.query<{handle:string;following:boolean}>(`SELECT u.handle,EXISTS(SELECT 1 FROM follows f WHERE f.creator_id=u.id AND f.follower_id=$2) AS following FROM users u WHERE u.id=$1`, [room.host_id, user.id]),
          stageSnapshot(db, room, user.id),
          shared.match ? db.query(`SELECT side AS voted,contestant_id AS voted_for FROM live_votes WHERE match_id=$1 AND user_id=$2`, [shared.match.id,user.id]) : undefined,
        ]);
        return { ...shared, self, hostProfile: profile.rows[0], stage,
          match: shared.match ? { ...shared.match, ...vote?.rows[0] } : undefined };
      }
    }
    return lockedRoom(id, async (client, room) => {
      const self = await member(client, room, user);
      await settle(client, room);
      const {rows:[hostProfile]}=await client.query<{handle:string;following:boolean}>(`
        SELECT u.handle,EXISTS(SELECT 1 FROM follows f WHERE f.creator_id=u.id AND f.follower_id=$2) AS following
        FROM users u WHERE u.id=$1`,[room.host_id,user.id]);
      const { rows: [match] } = await client.query(`
        SELECT m.id,m.guest_id,m.status,m.starts_at,m.ends_at,m.expires_at,m.host_score,m.guest_score,m.winner_id,m.outcome,
          u.display_name AS guest_name, v.side AS voted, v.contestant_id AS voted_for
        FROM live_matches m JOIN users u ON u.id=m.guest_id
        LEFT JOIN live_votes v ON v.match_id=m.id AND v.user_id=$2 WHERE m.room_id=$1
        ORDER BY m.updated_at DESC,m.id DESC LIMIT 1`, [room.id, user.id]);
      return {
        self, hostProfile, room: { id: room.id, host_id: room.host_id, ended: !!room.ended_at,
          endedReason: room.end_reason, endsAt: room.deadline_at, chat_open: room.chat_open, pinned_id: room.pinned_id, guest_access: room.guest_access },
        likes: likeGoal(room),
        audienceBudget: self.role === 'host' && room.invite_plan_id ? await audienceBalance(client, room.invite_plan_id) : undefined,
        audienceDelivery: self.role === 'host' && streamEnabled && room.invite_plan_id
          ? (await client.query('SELECT 1 FROM live_streams WHERE room_id=$1 AND available', [id])).rowCount ? 'ready' : 'starting'
          : undefined,
        match:match?{...match,guests:await matchGuests(client,match.id)}:undefined,
        stage: await stageSnapshot(client, room, user.id), messages: await roomMessages(client, room),
        gifts: await recentGifts(client, room.id), now: Date.now(),
      };
    });
  }

  @Post(':id/likes')
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  async likeLive(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id') raw: string, @Body() input: unknown) {
    const id = uuid(raw);
    const { taps, code } = parse(z.object({ taps: z.number().int().min(1).max(20), code: z.string().optional() }), input);
    const user = await identity(req.cookies[cookie]);
    let actor: string;
    if (user && !code) {
      actor = user.id;
      if (!await joinedAudience(db, id, user.id)) await connectedUser(id, user.id);
    } else {
      if (!code) throw new ForbiddenException('Join the LIVE first.');
      const invite = await handoffRoom(code);
      if (invite.id !== id || !isAudienceCode(invite.code)) throw new ForbiddenException('Join the LIVE first.');
      const browser = browserKey(req, res);
      checkInvite(invite, browser);
      actor = guestIdentityPrefix + browser;
      if (!await streamRoom(id)) await connectedUser(id, actor);
      else if (!(await db.query('SELECT 1 FROM live_invite_viewers WHERE code=$1 AND browser_key=$2', [invite.code, browser])).rowCount) {
        throw new ForbiddenException('Join the LIVE first.');
      }
    }
    return lockedRoom(id, async (client, room) => {
      requireOpen(room);
      if (user) await member(client, room, user);
      if (user?.id === room.host_id || (code && !room.guest_access)) throw new ForbiddenException('Viewer likes only.');
      const bucket = Math.floor(Date.now() / 10000);
      const previous = (await client.query<{ taps: number }>(
        'SELECT taps FROM live_like_batches WHERE room_id=$1 AND actor=$2 AND bucket=$3', [id, actor, bucket])).rows[0]?.taps ?? 0;
      const accepted = Math.min(taps, 30 - previous);
      if (accepted > 0) {
        await client.query(`INSERT INTO live_like_batches(room_id,actor,bucket,taps) VALUES($1,$2,$3,$4)
          ON CONFLICT(room_id,actor,bucket) DO UPDATE SET taps=EXCLUDED.taps`, [id, actor, bucket, previous + accepted]);
        await client.query('UPDATE live_rooms SET like_total=like_total+$2 WHERE id=$1', [id, accepted]);
      }
      return { accepted };
    });
  }

  @Post(':id/chat')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async chat(@Req() req: Request, @Param('id') raw: string, @Body() input: unknown) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const { body } = parse(z.object({ body: cleanText(300) }), input);
    if (!await joinedAudience(db, id, user.id)) await connectedUser(id, user.id);
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
      z.object({ action: z.literal('invite'), handle: handleSchema, seconds:z.union([z.literal(60),z.literal(180),z.literal(300)]).default(180) }),
      z.object({ action: z.literal('invite-four'), handles:z.array(handleSchema).length(3),
        seconds:z.union([z.literal(60),z.literal(180),z.literal(300)]).default(180) }),
      z.object({ action: z.enum(['accept', 'decline', 'cancel', 'restore', 'ready', 'forfeit']), matchId: z.uuid() }),
      z.object({ action: z.literal('vote'), matchId: z.uuid(), side: z.enum(['host', 'guest']).optional(), contestantId:z.uuid().optional() }),
    ]), input);
    if (command.action !== 'vote' || !await joinedAudience(db, id, user.id)) await connectedUser(id, user.id);
    if (command.action === 'ready') await waitForCamera(id, user.id);
    const result = await lockedRoom(id, async (client, room) => {
      requireOpen(room);
      await member(client, room, user);
      await settle(client, room);
      const host = room.host_id === user.id;
      const match = await currentMatch(client, room);

      if (command.action === 'invite'||command.action==='invite-four') {
        if (!host) throw new ForbiddenException('Only the host can invite a challenger.');
        if (match) throw new ConflictException('Finish the current invite or match first.');
        if ((await client.query(`SELECT 1 FROM live_stage_seats WHERE room_id=$1
          AND (accepted_at IS NOT NULL OR expires_at>clock_timestamp()) LIMIT 1`, [id])).rowCount) {
          throw new ConflictException('Clear the guest stage before starting a challenge.');
        }
        await client.query('UPDATE live_rooms SET spotlight_id=NULL,spotlight_fullscreen=false WHERE id=$1 AND spotlight_id IS NOT NULL', [id]);
        const handles=command.action==='invite'?[command.handle]:command.handles;
        const {rows:people}=await client.query<Person>('SELECT id,handle,display_name FROM users WHERE handle=ANY($1::text[])',[handles]);
        if(people.length!==handles.length||people.some(person=>person.id===user.id))
          throw new NotFoundException('Enter distinct handles for other Tiktok mwitu accounts.');
        const ordered=handles.map(handle=>people.find(person=>person.handle===handle)!);
        for(const guest of ordered)await member(client,room,guest);
        const {rows:[created]}=await client.query<{id:string}>(`INSERT INTO live_matches(room_id,guest_id,status,expires_at,duration_seconds)
          VALUES ($1,$2,'invited',clock_timestamp()+interval '5 minutes',$3) RETURNING id`, [id, ordered[0].id,command.seconds]);
        if(ordered.length===3)await client.query(`INSERT INTO live_match_guests(match_id,user_id,position)
          SELECT $1,user_id,position FROM unnest($2::uuid[]) WITH ORDINALITY AS people(user_id,position)`,[created.id,ordered.map(person=>person.id)]);
        return { ok: true };
      }

      if (!match || match.id !== command.matchId) return { ok: false, message: 'This match is no longer available.' };
      const roster=await matchGuests(client,match.id);
      const contestant=roster.find(person=>person.user_id===user.id);
      const guest=roster.length?!!contestant:user.id===match.guest_id;

      switch (command.action) {
        case 'accept':
          if (!guest || (roster.length ? contestant?.status!=='invited'||!['invited','ready'].includes(match.status) : match.status!=='invited')) throw new ForbiddenException();
          await liveService().updateParticipant(roomName(id), user.id, { permission: publishPermission(true) });
          if(contestant)await client.query("UPDATE live_match_guests SET status='accepted' WHERE match_id=$1 AND user_id=$2",[match.id,user.id]);
          await client.query(`UPDATE live_matches SET status='ready',expires_at=CASE WHEN $2 THEN expires_at ELSE now()+interval '45 seconds' END,
            updated_at=now() WHERE id=$1`,[match.id,roster.length>0]);
          break;
        case 'restore':
          if (!guest || contestant?.status==='invited' || !['ready', 'running'].includes(match.status)) throw new ForbiddenException();
          await liveService().updateParticipant(roomName(id), user.id, { permission: publishPermission(true) });
          break;
        case 'ready': {
          if (!guest || contestant?.status==='invited' || match.status !== 'ready') throw new ForbiddenException();
          if(contestant){
            await client.query("UPDATE live_match_guests SET status='ready' WHERE match_id=$1 AND user_id=$2",[match.id,user.id]);
            if(roster.some(person=>person.user_id!==user.id&&person.status!=='ready'))break;
          }
          await client.query(`
            UPDATE live_matches SET status='running',starts_at=statement_timestamp()+interval '5 seconds',
              ends_at=statement_timestamp()+make_interval(secs=>duration_seconds + 5),updated_at=now() WHERE id=$1`, [match.id]);
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
          const target=command.contestantId??(command.side==='host'?room.host_id:command.side==='guest'&&!roster.length?match.guest_id:undefined);
          if(!target||(target!==room.host_id&&(roster.length?!roster.some(person=>person.user_id===target):match.guest_id!==target)))
            throw new NotFoundException('Choose a contestant in this challenge.');
          const side=target===room.host_id?'host':'guest';
          const { rowCount } = await client.query(`
            INSERT INTO live_votes(match_id,user_id,side,contestant_id)
            SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM live_matches WHERE id=$1 AND ends_at>clock_timestamp())
            ON CONFLICT DO NOTHING`, [match.id, user.id, side,target]);
          if (!rowCount) return { ok: false, message: 'Voting is closed or you already voted.' };
          if(side==='guest'&&roster.length){
            await client.query('UPDATE live_match_guests SET score=score+1 WHERE match_id=$1 AND user_id=$2',[match.id,target]);
          }else{
            const column=side==='host'?'host_score':'guest_score';
            await client.query('UPDATE live_matches SET ' + column + '=' + column + '+1 WHERE id=$1', [match.id]);
          }
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
