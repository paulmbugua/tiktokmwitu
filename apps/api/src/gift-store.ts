import type { PoolClient } from 'pg';
import { db } from './infra';

export const giftCatalog = [
  { id: 'spark', name: 'Mtaa Spark', coins: 10, description: 'A little glow for a big moment' },
  { id: 'matatu', name: 'Matatu Groove', coins: 35, description: 'Pull up with colour' },
  { id: 'chai', name: 'Chai Break', coins: 20, description: 'A warm shout-out' },
  { id: 'drums', name: 'Ngoma Wave', coins: 75, description: 'Bring the rhythm' },
  { id: 'crown', name: 'Simba Crown', coins: 150, description: 'Crown the moment' },
  { id: 'comet', name: 'Nairobi Comet', coins: 350, description: 'Light up the skyline' },
] as const;

export const coinPacks = [
  { id: '100', coins: 100, kes: 100 },
  { id: '300', coins: 300, kes: 300 },
  { id: '700', coins: 700, kes: 700 },
] as const;

export const giftSchema = `
CREATE TABLE IF NOT EXISTS gift_wallets (
  user_id uuid PRIMARY KEY REFERENCES users,
  balance integer NOT NULL DEFAULT 0 CHECK(balance>=0)
);
CREATE TABLE IF NOT EXISTS gift_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  request_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('mpesa','card')),
  amount_kes integer NOT NULL CHECK(amount_kes>0),
  coins integer NOT NULL CHECK(coins>0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
  checkout_id text UNIQUE,
  checkout_url text,
  next_check_at timestamptz NOT NULL DEFAULT now()+interval '30 seconds',
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE(user_id,request_id)
);
CREATE INDEX IF NOT EXISTS gift_topups_pending ON gift_topups(next_check_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS gift_topups_user ON gift_topups(user_id,created_at DESC);
ALTER TABLE gift_topups ADD COLUMN IF NOT EXISTS mpesa_phone_digest text;
CREATE TABLE IF NOT EXISTS live_gifts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL,
  room_id uuid NOT NULL REFERENCES live_rooms,
  sender_id uuid NOT NULL REFERENCES users,
  recipient_id uuid NOT NULL REFERENCES users,
  gift_id text NOT NULL,
  coins integer NOT NULL CHECK(coins>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sender_id,request_id),
  CHECK(sender_id<>recipient_id)
);
CREATE INDEX IF NOT EXISTS live_gifts_recent ON live_gifts(room_id,id DESC);
CREATE INDEX IF NOT EXISTS live_gifts_sent ON live_gifts(sender_id,id DESC);
CREATE INDEX IF NOT EXISTS live_gifts_received ON live_gifts(recipient_id,id DESC);
`;

export type Topup = {
  id: string; user_id: string; provider: 'mpesa' | 'card'; amount_kes: number; coins: number;
  status: 'pending' | 'paid' | 'failed'; checkout_id: string | null; checkout_url: string | null;
  created_at: Date;
};

export async function coinBalance(userId: string, client: Pick<PoolClient, 'query'> = db) {
  const { rows: [row] } = await client.query<{ balance: number }>('SELECT balance FROM gift_wallets WHERE user_id=$1', [userId]);
  return row?.balance ?? 0;
}

export async function creditTopup(payment: Topup) {
  await db.query(`
    WITH paid AS (UPDATE gift_topups SET status='paid',paid_at=now(),checkout_url=NULL
      WHERE id=$1 AND status='pending' RETURNING user_id,coins)
    INSERT INTO gift_wallets(user_id,balance) SELECT user_id,coins FROM paid
    ON CONFLICT(user_id) DO UPDATE SET balance=gift_wallets.balance+EXCLUDED.balance`, [payment.id]);
}

export async function recentGifts(client: PoolClient, roomId: string) {
  const { rows } = await client.query(`
    SELECT g.id::text,g.gift_id,g.created_at,s.handle AS sender,r.display_name AS recipient
    FROM live_gifts g JOIN users s ON s.id=g.sender_id JOIN users r ON r.id=g.recipient_id
    WHERE g.room_id=$1 AND g.created_at>now()-interval '1 minute' ORDER BY g.id DESC LIMIT 20`, [roomId]);
  return rows.reverse().map(row => ({ ...row, name: giftCatalog.find(gift => gift.id === row.gift_id)?.name ?? 'Gift' }));
}
