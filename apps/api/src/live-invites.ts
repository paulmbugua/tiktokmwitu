import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { commerceTransaction, lockWallet, spendCoins } from './commerce';
import { coinBalance } from './gift-store';
import { db, parse, requireUser, uuid } from './infra';
import { lockedRoom, requireOpen } from './live-store';

export const inviteSchema = `
CREATE TABLE IF NOT EXISTS live_invite_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
  request_id uuid NOT NULL, coins int NOT NULL CHECK(coins IN (1000,2000)),
  daily_limit int GENERATED ALWAYS AS (coins/200) STORED,
  ends_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  UNIQUE(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS live_invite_plans_user ON live_invite_plans(user_id,ends_at DESC);
CREATE TABLE IF NOT EXISTS live_invite_passes (
  code text PRIMARY KEY DEFAULT upper(left(replace(gen_random_uuid()::text,'-',''),16)),
  room_id uuid NOT NULL REFERENCES live_rooms, plan_id uuid NOT NULL REFERENCES live_invite_plans,
  request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  created_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'Africa/Nairobi')::date),
  expires_at timestamptz NOT NULL, claim_browser text, claim_user uuid REFERENCES users, claimed_at timestamptz,
  UNIQUE(plan_id,request_id)
);
CREATE INDEX IF NOT EXISTS live_invite_daily ON live_invite_passes(plan_id,created_day);
CREATE TABLE IF NOT EXISTS live_invite_viewers (
  code text NOT NULL REFERENCES live_invite_passes ON DELETE CASCADE,
  browser_key text NOT NULL,
  PRIMARY KEY(code,browser_key)
);
CREATE INDEX IF NOT EXISTS live_invite_expiration ON live_invite_passes(expires_at);
`;

type Plan = { id: string; coins: number; daily_limit: number; ends_at: Date };
export type InvitePass = { code: string; room_id: string; claim_browser: string | null; claim_user: string | null; expires_at: Date };
const activePlanSql = 'SELECT * FROM live_invite_plans WHERE user_id=$1 AND ends_at>now() ORDER BY ends_at DESC LIMIT 1';
export const isAudienceCode = (code: string) => /^\d{6}$/.test(code);

export function checkInvite(pass: InvitePass | undefined, browser: string, userId?: string) {
  if (!pass) throw new NotFoundException('This LIVE invite is unavailable.');
  if (isAudienceCode(pass.code)) {
    if (pass.expires_at <= new Date()) throw new NotFoundException('This LIVE invite has expired.');
    return pass;
  }
  if (pass.claim_browser) {
    if ((userId && pass.claim_user && userId !== pass.claim_user) ||
        (pass.claim_browser !== browser && (!userId || pass.claim_user !== userId))) {
      throw new ConflictException('This invite has already been claimed.');
    }
  } else if (pass.expires_at <= new Date()) throw new NotFoundException('This LIVE invite has expired.');
  return pass;
}

export async function claimInvite(client: PoolClient, code: string, roomId: string, browser: string, userId?: string) {
  const { rows: [row] } = await client.query<InvitePass>(
    'SELECT * FROM live_invite_passes WHERE code=$1 AND room_id=$2 FOR UPDATE', [code, roomId]);
  const pass = checkInvite(row, browser, userId);
  if (isAudienceCode(pass.code)) {
    if (!userId) await client.query('INSERT INTO live_invite_viewers(code,browser_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [code, browser]);
    return;
  }
  await client.query(`UPDATE live_invite_passes SET claim_browser=COALESCE(claim_browser,$2),
    claim_user=COALESCE(claim_user,$3),claimed_at=COALESCE(claimed_at,now()) WHERE code=$1`, [pass.code, browser, userId ?? null]);
}

export const inviteCodePattern = /^(?:\d{6}|[A-F0-9]{16})$/;
export const normalizeInvite = (value: string) => parse(z.string().trim().toUpperCase()
  .regex(inviteCodePattern, 'Enter the 6-digit LIVE code.'), value);

export async function sweepInviteCodes() {
  await db.query(`
    DELETE FROM live_invite_passes p USING live_rooms r
    WHERE p.room_id=r.id AND r.ended_at IS NOT NULL AND p.expires_at<now()-interval '30 days'`);
}

@Controller('live-invites')
export class LiveInvitesController {
  @Get()
  async overview(@Req() req: Request) {
    const user = await requireUser(req);
    const { rows: [plan] } = await db.query<Plan>(activePlanSql, [user.id]);
    const { rows } = plan ? await db.query<{ count: number }>(
      "SELECT count(*)::int FROM live_invite_passes WHERE plan_id=$1 AND created_day=(now() AT TIME ZONE 'Africa/Nairobi')::date", [plan.id])
      : { rows: [] };
    return { plans: [{ coins: 1000, limit: 5 }, { coins: 2000, limit: 10 }], plan,
      used: rows[0]?.count ?? 0, balance: await coinBalance(user.id) };
  }

  @Post('purchase')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  async purchase(@Req() req: Request, @Body() body: unknown) {
    const user = await requireUser(req);
    const input = parse(z.object({ requestId: z.uuid(), coins: z.union([z.literal(1000), z.literal(2000)]) }), body);
    return commerceTransaction(async client => {
      await lockWallet(client, user.id);
      const { rows: [existing] } = await client.query<Plan>(
        'SELECT * FROM live_invite_plans WHERE user_id=$1 AND request_id=$2', [user.id, input.requestId]);
      if (existing) {
        if (existing.coins !== input.coins) throw new ConflictException('Choose a new purchase for a different plan.');
        return existing;
      }
      if ((await client.query(activePlanSql, [user.id])).rowCount) throw new ConflictException('Your weekly plan is still active.');
      await spendCoins(client, user.id, input.coins);
      return (await client.query<Plan>(
        'INSERT INTO live_invite_plans(user_id,request_id,coins) VALUES($1,$2,$3) RETURNING *', [user.id, input.requestId, input.coins])).rows[0];
    });
  }

  @Post(':roomId/create')
  async create(@Req() req: Request, @Param('roomId') raw: string, @Body() body: unknown) {
    const user = await requireUser(req);
    const { requestId } = parse(z.object({ requestId: z.uuid() }), body);
    return lockedRoom(uuid(raw), async (client, room) => {
      requireOpen(room);
      if (room.host_id !== user.id) throw new ForbiddenException('Only the host can create LIVE invites.');
      const { rows: [plan] } = await client.query<Plan>(activePlanSql + ' FOR UPDATE', [user.id]);
      if (!plan) throw new ConflictException('Activate a weekly invite plan first.');
      const { rows: [prior] } = await client.query<InvitePass>(
        'SELECT * FROM live_invite_passes WHERE plan_id=$1 AND request_id=$2', [plan.id, requestId]);
      if (prior) {
        if (prior.room_id !== room.id) throw new ConflictException('Make a new invite for this LIVE.');
        return { code: prior.code, expiresAt: prior.expires_at };
      }
      const { rows: [{ count }] } = await client.query<{ count: number }>(
        "SELECT count(*)::int FROM live_invite_passes WHERE plan_id=$1 AND created_day=(now() AT TIME ZONE 'Africa/Nairobi')::date", [plan.id]);
      if (count >= plan.daily_limit) throw new ConflictException('Today’s invite limit has been reached. It resets at midnight in Kenya.');
      for (let attempt=0;attempt<12;attempt++) {
        const code=String(randomInt(100000,1000000));
        const { rows: [invite] } = await client.query<InvitePass>(`
          INSERT INTO live_invite_passes(code,room_id,plan_id,request_id,expires_at)
          VALUES($1,$2,$3,$4,LEAST($5,now()+interval '24 hours'))
          ON CONFLICT(code) DO NOTHING RETURNING code,expires_at`, [code,room.id,plan.id,requestId,plan.ends_at]);
        if(invite)return {code:invite.code,expiresAt:invite.expires_at};
      }
      throw new ServiceUnavailableException('Could not allocate a LIVE code. Try again.');
    });
  }

  @Get(':roomId/passes')
  async passes(@Req() req: Request, @Param('roomId') raw: string) {
    const user = await requireUser(req);
    const { rows } = await db.query(`
      SELECT p.code,p.expires_at AS "expiresAt",p.claimed_at IS NOT NULL AS claimed
      FROM live_invite_passes p JOIN live_rooms r ON r.id=p.room_id
      WHERE r.host_id=$1 AND r.id=$2 AND p.expires_at>now() ORDER BY p.created_at DESC LIMIT 20`, [user.id, uuid(raw)]);
    return rows;
  }
}
