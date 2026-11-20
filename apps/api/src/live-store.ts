import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { db, type Person } from './infra';

export const liveSchema = `
CREATE TABLE IF NOT EXISTS live_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  online_at timestamptz,
  ended_at timestamptz,
  chat_open boolean NOT NULL DEFAULT true,
  keywords text[] NOT NULL DEFAULT '{}',
  pinned_id uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS live_one_room_per_host ON live_rooms(host_id) WHERE ended_at IS NULL;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS share_code text;
UPDATE live_rooms SET share_code=upper(left(replace(id::text,'-',''),12)) WHERE share_code IS NULL;
ALTER TABLE live_rooms ALTER COLUMN share_code SET DEFAULT upper(left(replace(gen_random_uuid()::text,'-',''),12));
ALTER TABLE live_rooms ALTER COLUMN share_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS live_room_share_code ON live_rooms(share_code);
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS guest_access boolean NOT NULL DEFAULT true;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS spotlight_id uuid REFERENCES users ON DELETE SET NULL;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS spotlight_fullscreen boolean NOT NULL DEFAULT false;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS stage_cards int NOT NULL DEFAULT 8 CHECK(stage_cards IN (2,4,6,8));
CREATE TABLE IF NOT EXISTS live_stage_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES live_rooms ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  invited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes',
  accepted_at timestamptz,
  missing_since timestamptz,
  UNIQUE(room_id,user_id)
);
CREATE TABLE IF NOT EXISTS live_stage_requests (
  room_id uuid NOT NULL REFERENCES live_rooms ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(room_id,user_id)
);
CREATE TABLE IF NOT EXISTS live_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES live_rooms ON DELETE CASCADE,
  guest_id uuid NOT NULL REFERENCES users,
  status text NOT NULL CHECK (status IN ('invited','ready','running','finished','cancelled')),
  starts_at timestamptz,
  ends_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  host_score integer NOT NULL DEFAULT 0,
  guest_score integer NOT NULL DEFAULT 0,
  winner_id uuid REFERENCES users,
  outcome text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS live_one_match_per_room ON live_matches(room_id)
  WHERE status IN ('invited','ready','running');
CREATE INDEX IF NOT EXISTS live_matches_room ON live_matches(room_id,updated_at DESC);
ALTER TABLE live_matches ADD COLUMN IF NOT EXISTS duration_seconds int NOT NULL DEFAULT 180 CHECK(duration_seconds IN (60,180,300));
CREATE TABLE IF NOT EXISTS live_match_guests (
  match_id uuid NOT NULL REFERENCES live_matches ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  position int NOT NULL CHECK(position BETWEEN 1 AND 3),
  status text NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','accepted','ready')),
  score int NOT NULL DEFAULT 0,
  PRIMARY KEY(match_id,user_id), UNIQUE(match_id,position)
);
CREATE TABLE IF NOT EXISTS live_votes (
  match_id uuid NOT NULL REFERENCES live_matches ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  side text NOT NULL CHECK(side IN ('host','guest')),
  PRIMARY KEY(match_id,user_id)
);
ALTER TABLE live_votes ADD COLUMN IF NOT EXISTS contestant_id uuid REFERENCES users;
CREATE TABLE IF NOT EXISTS live_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES live_rooms ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  body varchar(300) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS live_messages_room ON live_messages(room_id,created_at DESC);
CREATE TABLE IF NOT EXISTS live_members (
  room_id uuid NOT NULL REFERENCES live_rooms ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  moderator boolean NOT NULL DEFAULT false,
  muted_until timestamptz,
  banned boolean NOT NULL DEFAULT false,
  joined_at timestamptz,
  PRIMARY KEY(room_id,user_id)
);
CREATE TABLE IF NOT EXISTS live_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES live_rooms ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users,
  target_id uuid REFERENCES users,
  action text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_audit_room ON live_audit(room_id,id DESC);
CREATE TABLE IF NOT EXISTS live_reports (
  room_id uuid NOT NULL REFERENCES live_rooms ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES users,
  target_id uuid NOT NULL REFERENCES users,
  reason varchar(300) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(room_id,reporter_id,target_id)
);
`;

export type LiveRoom = {
  id: string; host_id: string; online_at: Date | null; ended_at: Date | null; created_at: Date;
  chat_open: boolean; keywords: string[]; pinned_id: string | null; share_code: string; guest_access: boolean;
  spotlight_id: string | null; spotlight_fullscreen: boolean; stage_cards: number;
  invite_plan_id: string | null; deadline_at: Date | null; end_reason: string | null;
};

export async function stageSnapshot(client: PoolClient | typeof db, room: LiveRoom, userId: string | null) {
  const capacity=room.stage_cards-1;
  if (room.ended_at) return { spotlight: null, fullscreen: false, capacity, seats: [], requests: [], openSeats: 0 };
  const { rows: seats } = await client.query(`
    SELECT s.id,s.user_id,u.display_name,u.handle,s.accepted_at IS NOT NULL AS on_stage
    FROM live_stage_seats s JOIN users u ON u.id=s.user_id
    WHERE s.room_id=$1 AND (s.accepted_at IS NOT NULL OR
      (s.expires_at>clock_timestamp() AND ($2::uuid=$3::uuid OR s.user_id=$2)))
    ORDER BY s.invited_at,s.id`, [room.id, userId, room.host_id]);
  const spotlight = seats.some(seat => seat.on_stage && seat.user_id === room.spotlight_id) || room.spotlight_id === room.host_id
    ? room.spotlight_id : null;
  const {rows:[{reserved}]} = await client.query<{reserved:number}>(`
    SELECT count(*)::int AS reserved FROM live_stage_seats WHERE room_id=$1
    AND (accepted_at IS NOT NULL OR expires_at>clock_timestamp())`, [room.id]);
  const requests = userId ? (await client.query<Person>(`
    SELECT u.id,u.handle,u.display_name FROM live_stage_requests r JOIN users u ON u.id=r.user_id
    JOIN live_members m ON m.room_id=r.room_id AND m.user_id=r.user_id AND NOT m.banned
    WHERE r.room_id=$1 AND ($2::uuid=$3::uuid OR r.user_id=$2)
    AND r.requested_at>clock_timestamp()-interval '5 minutes'
    ORDER BY r.requested_at,u.id LIMIT 100`, [room.id,userId,room.host_id])).rows : [];
  return { spotlight, fullscreen: !!spotlight && room.spotlight_fullscreen, capacity, seats, requests, openSeats: Math.max(0,capacity-reserved) };
}

export async function dropStageSeat(client: PoolClient, roomId: string, userId: string) {
  await client.query('DELETE FROM live_stage_requests WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
  await client.query('DELETE FROM live_stage_seats WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
  await client.query('UPDATE live_rooms SET spotlight_id=NULL,spotlight_fullscreen=false WHERE id=$1 AND spotlight_id=$2', [roomId, userId]);
}
export type Match = {
  id: string; room_id: string; guest_id: string; status: 'invited' | 'ready' | 'running' | 'finished' | 'cancelled';
  starts_at: Date | null; ends_at: Date | null; expires_at: Date;
  host_score: number; guest_score: number; winner_id: string | null; outcome: string | null;
  duration_seconds:number;
};
export type MatchGuest={user_id:string;display_name:string;status:'invited'|'accepted'|'ready';score:number};

export async function matchGuests(client:PoolClient | typeof db,matchId:string){
  return (await client.query<MatchGuest>(`
    SELECT g.user_id,u.display_name,g.status,g.score FROM live_match_guests g JOIN users u ON u.id=g.user_id
    WHERE g.match_id=$1 ORDER BY g.position`,[matchId])).rows;
}

async function matchWinner(client:PoolClient,room:LiveRoom,match:Match,forfeiter?:string){
  const guests=await matchGuests(client,match.id);
  const scores=[{id:room.host_id,score:match.host_score},...(guests.length
    ? guests.map(guest=>({id:guest.user_id,score:guest.score}))
    : [{id:match.guest_id,score:match.guest_score}])]
    .filter(person=>person.id!==forfeiter).sort((a,b)=>b.score-a.score);
  return scores[0]&&scores[0].score!==scores[1]?.score?scores[0].id:null;
}
type Member = { moderator: boolean; muted_until: Date | null; banned: boolean };
export const openMatch = "status IN ('invited','ready','running')";

export async function lockedRoom<T>(id: string, work: (client: PoolClient, room: LiveRoom) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [room] } = await client.query<LiveRoom>('SELECT * FROM live_rooms WHERE id=$1 FOR UPDATE', [id]);
    if (!room) throw new NotFoundException('Broadcast not found.');
    const result = await work(client, room);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function requireOpen(room: LiveRoom) {
  if (!room.online_at || room.ended_at || (room.deadline_at && room.deadline_at <= new Date()))
    throw new ConflictException('This broadcast is offline.');
}

export async function member(client: PoolClient | typeof db, room: LiveRoom, user: Person) {
  const { rows: [entry] } = await client.query<Member>(
    'SELECT moderator,muted_until,banned FROM live_members WHERE room_id=$1 AND user_id=$2', [room.id, user.id]);
  if (entry?.banned) throw new ForbiddenException('You are blocked from this LIVE.');
  return { role: room.host_id === user.id ? 'host' : entry?.moderator ? 'moderator' : 'viewer', mutedUntil: entry?.muted_until ?? null };
}

export async function currentMatch(client: PoolClient, room: LiveRoom): Promise<Match | undefined> {
  const { rows: [match] } = await client.query<Match>(
    'SELECT * FROM live_matches WHERE room_id=$1 AND ' + openMatch + ' ORDER BY updated_at DESC LIMIT 1', [room.id]);
  return match;
}

export async function settle(client: PoolClient, room: LiveRoom) {
  const match = await currentMatch(client, room);
  if (!match) return false;
  if (match.status === 'running' && match.ends_at! <= new Date()) {
    const winner=await matchWinner(client,room,match);
    await client.query("UPDATE live_matches SET status='finished',outcome='time',winner_id=$2,updated_at=now() WHERE id=$1",
      [match.id, winner]);
    return true;
  }
  if (['invited', 'ready'].includes(match.status) && match.expires_at <= new Date()) {
    await client.query("UPDATE live_matches SET status='cancelled',outcome='expired',updated_at=now() WHERE id=$1", [match.id]);
    return true;
  }
  return false;
}

export async function endMatch(client: PoolClient, room: LiveRoom, outcome: string, forfeiter?: string) {
  const match = await currentMatch(client, room);
  if (!match) return;
  const winner = forfeiter && match.status === 'running'
    ? await matchWinner(client,room,match,forfeiter) : null;
  await client.query('UPDATE live_matches SET status=$2,outcome=$3,winner_id=$4,updated_at=now() WHERE id=$1',
    [match.id, forfeiter && match.status==='running' ? 'finished' : 'cancelled', outcome, winner]);
}
