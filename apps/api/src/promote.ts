import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { browserKey, commerceTransaction, lockWallet, spendCoins } from './commerce';
import { coinBalance } from './gift-store';
import { cookie, db, identity, parse, requireUser, uuid } from './infra';

const goals = ['engagement', 'views', 'followers', 'profile', 'sales', 'live-views', 'live-followers'] as const;
type Goal = (typeof goals)[number];
const prices: Record<Goal, number> = { engagement: 2, views: 1, followers: 3, profile: 2, sales: 3, 'live-views': 2, 'live-followers': 3 };
const ctas = ['Shop now', 'Learn more', 'Book now', 'Sign up'] as const;
const inputSchema = z.object({
  requestId: z.uuid(), goal: z.enum(goals), budget: z.number().int().min(100).max(5000).multipleOf(50),
  duration: z.number().int().min(1).max(14), creatives: z.array(z.uuid()).max(3).default([]),
  liveId: z.uuid().optional(), destination: z.string().max(1000).optional(), cta: z.enum(ctas).optional(),
});

export const promotionSchema = `
CREATE TABLE IF NOT EXISTS promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
  request_id uuid NOT NULL, goal text NOT NULL, creatives uuid[] NOT NULL DEFAULT '{}', live_id uuid REFERENCES live_rooms,
  destination text, cta text, budget int NOT NULL CHECK(budget>0), rate int NOT NULL CHECK(rate>0),
  impressions int NOT NULL DEFAULT 0, clicks int NOT NULL DEFAULT 0, refunded int NOT NULL DEFAULT 0,
  starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'active',
  UNIQUE(user_id, request_id)
);
CREATE INDEX IF NOT EXISTS promotion_active ON promotions(ends_at) WHERE status='active';
CREATE INDEX IF NOT EXISTS promotion_owner ON promotions(user_id,starts_at DESC);
CREATE TABLE IF NOT EXISTS promotion_views (
  promotion_id uuid NOT NULL REFERENCES promotions, viewer_key text NOT NULL, clicked boolean NOT NULL DEFAULT false,
  PRIMARY KEY(promotion_id,viewer_key)
);
`;

type Campaign = {
  id: string; user_id: string; goal: Goal; creatives: string[]; live_id: string | null; destination: string | null; cta: string | null;
  budget: number; rate: number; impressions: number; clicks: number; refunded: number; starts_at: Date; ends_at: Date; status: string;
};
const delivered = 'p.impressions < LEAST(p.budget/p.rate,GREATEST(1,ceil((p.budget/p.rate)*' +
  '(EXTRACT(epoch FROM (now()-p.starts_at))*1.0/NULLIF(EXTRACT(epoch FROM (p.ends_at-p.starts_at)),0)+0.16))))';
const signingKey = process.env.PROMOTE_SIGNING_KEY || process.env.LIVEKIT_API_SECRET || '';

function destinationUrl(value?: string) {
  try {
    const url = new URL(value ?? '');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !isIP(url.hostname.replace(/^\[|\]$/g, '')) &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) && !/\.(local|internal|localhost|test)$/i.test(url.hostname)) {
      return url.href;
    }
  } catch { /* The same validation error covers malformed links. */ }
  throw new BadRequestException('Enter a public HTTPS website URL.');
}

function signature(campaign: string, key: string, expires: number) {
  return createHmac('sha256', signingKey).update('mwitu-promote-v1:' + campaign + ':' + key + ':' + expires).digest('hex');
}

async function finish(client: PoolClient, campaign: Campaign, status: 'completed' | 'stopped') {
  const restored = campaign.budget - campaign.impressions * campaign.rate;
  if (restored) await client.query('UPDATE gift_wallets SET balance=balance+$2 WHERE user_id=$1', [campaign.user_id, restored]);
  await client.query('UPDATE promotions SET status=$2,refunded=$3 WHERE id=$1', [campaign.id, status, restored]);
}

let sweeping = false;
export async function settlePromotions() {
  if (sweeping) return;
  sweeping = true;
  try {
    const { rows } = await db.query<{ id: string }>(`
      SELECT p.id FROM promotions p WHERE p.status='active' AND (
        p.ends_at<=now() OR p.impressions>=p.budget/p.rate
        OR (p.live_id IS NOT NULL AND EXISTS(SELECT 1 FROM live_rooms r WHERE r.id=p.live_id AND r.ended_at IS NOT NULL))
        OR (p.live_id IS NULL AND NOT EXISTS(SELECT 1 FROM videos v WHERE v.id=ANY(p.creatives))))
      ORDER BY p.ends_at LIMIT 50`);
    for (const { id } of rows) await commerceTransaction(async client => {
      const { rows: [campaign] } = await client.query<Campaign>("SELECT * FROM promotions WHERE id=$1 AND status='active' FOR UPDATE", [id]);
      if (campaign) await finish(client, campaign, 'completed');
    });
  } catch (error) { console.error('Promotion settlement failed', error); }
  finally { sweeping = false; }
}

@Controller('promote')
export class PromoteController {
  @Get()
  async dashboard(@Req() req: Request) {
    const user = await requireUser(req);
    const [videos, campaigns, live, balance] = await Promise.all([
      db.query('SELECT id,caption FROM videos WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [user.id]),
      db.query<Campaign>('SELECT * FROM promotions WHERE user_id=$1 ORDER BY starts_at DESC LIMIT 25', [user.id]),
      db.query('SELECT id FROM live_rooms WHERE host_id=$1 AND online_at IS NOT NULL AND ended_at IS NULL', [user.id]),
      coinBalance(user.id),
    ]);
    return { videos: videos.rows, campaigns: campaigns.rows, liveId: live.rows[0]?.id, balance, prices, ctas, enabled: !!signingKey };
  }

  @Post()
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  async create(@Req() req: Request, @Body() body: unknown) {
    const user = await requireUser(req);
    if (!signingKey) throw new ConflictException('Promotions are currently unavailable.');
    const input = parse(inputSchema, body);
    const live = input.goal.startsWith('live-');
    if (live ? !input.liveId || input.duration > 12 || input.creatives.length > 0 : input.liveId || !input.creatives.length) {
      throw new BadRequestException('Choose eligible content for this goal.');
    }
    const creatives = [...new Set(input.creatives)].sort();
    if (input.goal !== 'sales' && creatives.length > 1) throw new BadRequestException('Choose one video for this goal.');
    const destination = input.goal === 'sales' ? destinationUrl(input.destination) : null;
    if (destination && !input.cta) throw new BadRequestException('Choose a call to action.');
    const milliseconds = input.duration * (live ? 15 * 60000 : 86400000);
    return commerceTransaction(async client => {
      await lockWallet(client, user.id);
      const { rows: [existing] } = await client.query<Campaign>('SELECT * FROM promotions WHERE user_id=$1 AND request_id=$2', [user.id, input.requestId]);
      if (existing) {
        if (existing.goal !== input.goal || existing.budget !== input.budget || existing.live_id !== (input.liveId ?? null) ||
            JSON.stringify(existing.creatives) !== JSON.stringify(creatives) || existing.destination !== destination ||
            existing.cta !== (destination ? input.cta : null) || existing.ends_at.getTime()-existing.starts_at.getTime() !== milliseconds) {
          throw new ConflictException('Start a new request for this promotion.');
        }
        return existing;
      }
      if (live) {
        if (!(await client.query('SELECT 1 FROM live_rooms WHERE id=$1 AND host_id=$2 AND online_at IS NOT NULL AND ended_at IS NULL',
          [input.liveId, user.id])).rowCount) throw new ForbiddenException('Go LIVE on your own account before boosting the broadcast.');
      } else if ((await client.query('SELECT id FROM videos WHERE user_id=$1 AND id=ANY($2::uuid[])', [user.id, creatives])).rowCount !== creatives.length) {
        throw new ForbiddenException('Choose videos from your own account.');
      }
      await spendCoins(client, user.id, input.budget);
      return (await client.query<Campaign>(`
        INSERT INTO promotions(user_id,request_id,goal,creatives,live_id,destination,cta,budget,rate,ends_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+$10::int * interval '1 second') RETURNING *`,
      [user.id, input.requestId, input.goal, creatives, input.liveId ?? null, destination, destination ? input.cta : null,
        input.budget, prices[input.goal], milliseconds/1000])).rows[0];
    });
  }

  @Post(':id/stop')
  async stop(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    return commerceTransaction(async client => {
      const { rows: [campaign] } = await client.query<Campaign>(
        'SELECT * FROM promotions WHERE id=$1 AND user_id=$2 FOR UPDATE', [uuid(raw), user.id]);
      if (!campaign) throw new NotFoundException('Promotion not found.');
      if (campaign.status === 'active') await finish(client, campaign, 'stopped');
      return { ok: true };
    });
  }

  @Get('placement')
  async placement(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query('surface') value: string) {
    const surface = parse(z.enum(['feed', 'live']), value);
    if (!signingKey) return null;
    const user = await identity(req.cookies[cookie]);
    const key = user?.id ?? browserKey(req, res);
    const { rows: [row] } = await db.query<Campaign & { creative: string | null }>(`
      SELECT p.*,c.id AS creative FROM promotions p
      LEFT JOIN live_rooms r ON r.id=p.live_id
      LEFT JOIN LATERAL (SELECT id FROM videos WHERE id=ANY(p.creatives) ORDER BY random() LIMIT 1) c ON true
      WHERE p.status='active' AND p.ends_at>now() AND p.user_id::text<>$1 AND ${delivered}
        AND NOT EXISTS(SELECT 1 FROM promotion_views v WHERE v.promotion_id=p.id AND v.viewer_key=$1)
        AND (($2='feed' AND p.live_id IS NULL AND c.id IS NOT NULL)
           OR ($2='live' AND r.online_at IS NOT NULL AND r.ended_at IS NULL))
      ORDER BY p.impressions::float/p.budget ASC,p.starts_at LIMIT 1`, [key, surface]);
    if (!row) return null;
    const expires = Math.floor(Date.now()/1000)+1800;
    return { id: row.id, videoId: row.creative, liveId: row.live_id, goal: row.goal, destination: row.destination, cta: row.cta,
      token: expires + '.' + signature(row.id, key, expires) };
  }

  @Post(':id/event')
  async event(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id') raw: string, @Body() body: unknown) {
    const id = uuid(raw);
    const { token, event } = parse(z.object({ token: z.string().regex(/^\d{10}\.[a-f0-9]{64}$/), event: z.enum(['view','click']) }), body);
    const viewer = await identity(req.cookies[cookie]);
    const key = viewer?.id ?? browserKey(req, res);
    const [timestamp, proof] = token.split('.');
    if (!signingKey || Number(timestamp) < Math.floor(Date.now()/1000) ||
        !timingSafeEqual(Buffer.from(proof,'hex'), Buffer.from(signature(id,key,Number(timestamp)),'hex'))) throw new ForbiddenException();
    return commerceTransaction(async client => {
      const { rows: [campaign] } = await client.query<Campaign & { available: boolean }>(`
        SELECT p.*,(${delivered}) AS available FROM promotions p WHERE p.id=$1 AND p.status='active' AND p.ends_at>now()
          AND (p.live_id IS NULL OR EXISTS(SELECT 1 FROM live_rooms r WHERE r.id=p.live_id AND r.ended_at IS NULL))
          AND (p.live_id IS NOT NULL OR EXISTS(SELECT 1 FROM videos v WHERE v.id=ANY(p.creatives)))
        FOR UPDATE`, [id]);
      if (!campaign || campaign.user_id === viewer?.id) return { ok: true };
      if (campaign.available && (await client.query(`
        INSERT INTO promotion_views(promotion_id,viewer_key) VALUES($1,$2) ON CONFLICT DO NOTHING`, [id,key])).rowCount) {
        await client.query('UPDATE promotions SET impressions=impressions+1 WHERE id=$1', [id]);
      }
      if (event === 'click' && (await client.query('UPDATE promotion_views SET clicked=true WHERE promotion_id=$1 AND viewer_key=$2 AND NOT clicked', [id,key])).rowCount) {
        await client.query('UPDATE promotions SET clicks=clicks+1 WHERE id=$1', [id]);
      }
      return { ok: true };
    });
  }
}
