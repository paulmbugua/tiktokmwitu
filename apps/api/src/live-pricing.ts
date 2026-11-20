import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { db } from './infra';

export const maxLiveMinutes = 60;
export const viewerMinutePack = { coins: 150, viewerMinutes: 10000 };
export const livePlans = [
  { coins: 1000, limit: 5, viewerMinutes: 50000 },
  { coins: 2000, limit: 10, viewerMinutes: 100000 },
];

export const livePricingSchema = `
ALTER TABLE live_invite_plans ADD COLUMN IF NOT EXISTS viewer_seconds_used bigint NOT NULL DEFAULT 0;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS invite_plan_id uuid REFERENCES live_invite_plans;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS meter_at timestamptz;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS meter_viewers integer NOT NULL DEFAULT 0;
ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS end_reason text;
UPDATE live_rooms SET deadline_at=online_at+interval '60 minutes'
WHERE ended_at IS NULL AND online_at IS NOT NULL AND deadline_at IS NULL;
CREATE TABLE IF NOT EXISTS live_viewer_packs (
  user_id uuid NOT NULL REFERENCES users,
  plan_id uuid NOT NULL REFERENCES live_invite_plans,
  request_id uuid NOT NULL,
  coins integer NOT NULL CHECK (coins > 0),
  viewer_seconds integer NOT NULL CHECK (viewer_seconds > 0),
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS live_viewer_packs_plan ON live_viewer_packs(plan_id);
`;

export const activePlanSql = 'SELECT * FROM live_invite_plans WHERE user_id=$1 AND ends_at>now() ORDER BY ends_at DESC LIMIT 1';
const allowance = `(p.coins::bigint * 3000 + COALESCE((
  SELECT sum(viewer_seconds) FROM live_viewer_packs WHERE plan_id=p.id
),0))`;
type Queryable = PoolClient | typeof db;

export async function audienceBalance(client: Queryable, planId: string) {
  const { rows: [plan] } = await client.query<{
    total_seconds: number; used_seconds: number; remaining_seconds: number; expired: boolean;
  }>(`SELECT ${allowance}::float8 AS total_seconds, p.viewer_seconds_used::float8 AS used_seconds,
    GREATEST(0,${allowance}-p.viewer_seconds_used)::float8 AS remaining_seconds,
    p.ends_at<=clock_timestamp() AS expired FROM live_invite_plans p WHERE p.id=$1`, [planId]);
  return plan;
}

export async function requireAudienceBalance(client: Queryable, planId: string | null) {
  if (!planId) return;
  const balance = await audienceBalance(client, planId);
  if (!balance || balance.expired) throw new ConflictException('This weekly LIVE plan has expired.');
  if (!balance.remaining_seconds) throw new ConflictException('Your viewer-minute allowance is used up. Add more viewer-minutes.');
}

export async function meterLive(client: PoolClient, roomId: string, planId: string, viewers: number) {
  await client.query('SELECT id FROM live_invite_plans WHERE id=$1 FOR UPDATE', [planId]);
  const balance = await audienceBalance(client, planId);
  if (balance.expired) return 'plan_expired';
  const { rows: [sample] } = await client.query<{ seconds: number; viewers: number }>(`
    SELECT floor(GREATEST(0,LEAST(15,extract(epoch FROM
      LEAST(clock_timestamp(),COALESCE(deadline_at,clock_timestamp()))-COALESCE(meter_at,online_at)))))::int AS seconds,
    meter_viewers AS viewers FROM live_rooms WHERE id=$1`, [roomId]);
  const charge = sample.seconds * sample.viewers;
  if (charge) await client.query(`
    UPDATE live_invite_plans SET viewer_seconds_used=viewer_seconds_used+$2 WHERE id=$1`, [planId, charge]);
  await client.query('UPDATE live_rooms SET meter_at=clock_timestamp(),meter_viewers=$2 WHERE id=$1', [roomId, viewers]);
  return charge >= balance.remaining_seconds ? 'audience_limit' : null;
}
