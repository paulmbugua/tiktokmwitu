import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Request, Response } from 'express';
import { cookieOptions, db, digest, newSession } from './infra';

export async function commerceTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function lockWallet(client: PoolClient, userId: string) {
  await client.query('INSERT INTO gift_wallets(user_id,balance) VALUES($1,0) ON CONFLICT DO NOTHING', [userId]);
  await client.query('SELECT user_id FROM gift_wallets WHERE user_id=$1 FOR UPDATE', [userId]);
}

export async function spendCoins(client: PoolClient, userId: string, coins: number) {
  const { rowCount } = await client.query(
    'UPDATE gift_wallets SET balance=balance-$2 WHERE user_id=$1 AND balance>=$2', [userId, coins]);
  if (!rowCount) throw new ConflictException('You need more coins. Open your Coin wallet to top up.');
}

export function browserKey(req: Request, res: Response) {
  const cookie = req.cookies.mwitu_browser;
  if (typeof cookie === 'string' && /^[A-Za-z0-9_-]{43}$/.test(cookie)) return digest(cookie);
  const token = newSession();
  res.cookie('mwitu_browser', token, { ...cookieOptions, maxAge: 365 * 86400000 });
  return digest(token);
}
