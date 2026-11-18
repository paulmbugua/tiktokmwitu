
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import type { Server } from 'socket.io';
import type { Request } from 'express';
import { BadRequestException, ExecutionContext, Injectable, UnauthorizedException, type CanActivate } from '@nestjs/common';
import { z } from 'zod';

export const db = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10000 });
export const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
export const adminOrigin = process.env.ADMIN_ORIGIN || origin;
export const allowedOrigins = [...new Set([origin, adminOrigin])];
export const cookie = 'mwitu_session';
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: origin.startsWith('https:'),
  path: '/',
};
export const mediaDir = process.env.MEDIA_DIR ?? './media';
export const uploadLimit = 48 * 1024 * 1024;
export const newSession = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = promisify(scrypt);

export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt, 64) as Buffer;
  return salt + ':' + key.toString('hex');
}

export async function checkPassword(password: string, stored?: string) {
  const salt = stored?.split(':')[0] ?? '00000000000000000000000000000000';
  const candidate = await hashPassword(password, salt);
  return stored !== undefined && timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
}

export type Person = { id: string; handle: string; display_name: string };

export async function identity(token: unknown): Promise<Person | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return (await db.query<Person>(
    `SELECT u.id,u.handle,u.display_name
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=$1 AND s.expires_at>now()`,
    [digest(token)],
  )).rows[0] ?? null;
}

export async function requireUser(req: Request & { mwituUser?: Person }) {
  if (req.mwituUser) return req.mwituUser;
  const user = await identity(req.cookies[cookie]);
  if (!user) throw new UnauthorizedException('Sign in to continue.');
  return user;
}

@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { mwituUser?: Person }>();
    req.mwituUser = await requireUser(req);
    return true;
  }
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
  return parsed.data;
}

export const uuid = (input: unknown) => parse(z.uuid(), input);
export const cleanText = (max: number) => z.string().trim().min(1).max(max).refine(s => !s.includes('\u0000'));
export const handleSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/, 'Use 3–24 lowercase letters, numbers or underscores.');
export const searchSchema = z.string().trim().max(80).refine(s => !s.includes('\u0000'));
export const passwordSchema = z.string().min(10, 'Use at least 10 characters.').max(128);

let io: Server;
export function connectRealtime(server: Server) { io = server; }
export function publishFeed() { io?.emit('feed:changed'); }
export function publishInbox(...users: string[]) {
  for (const user of users) io?.to('person:' + user).emit('inbox:changed');
}
export function disconnectSession(token: string) { io?.in('session:' + digest(token)).disconnectSockets(true); }
