
import { Body, ConflictException, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  checkPassword, cleanText, cookie, cookieOptions, db, digest, disconnectSession,
  handleSchema, hashPassword, identity, newSession, parse, passwordSchema, type Person,
} from './infra';

const credentials = z.object({ handle: handleSchema, password: passwordSchema });
const registration = credentials.extend({ display_name: cleanText(48) });
const week = 7 * 24 * 60 * 60 * 1000;

async function loginSession(req: Request, res: Response, user: Person) {
  const token = newSession();
  const previous = req.cookies[cookie];
  await db.query('INSERT INTO sessions VALUES ($1,$2,$3)', [digest(token), user.id, new Date(Date.now() + week)]);
  if (typeof previous === 'string') {
    await db.query('DELETE FROM sessions WHERE digest=$1', [digest(previous)]);
    disconnectSession(previous);
  }
  res.cookie(cookie, token, { ...cookieOptions, maxAge: week });
  return user;
}

@Controller('auth')
export class AuthController {
  @Get('me')
  async me(@Req() req: Request) { return { user: await identity(req.cookies[cookie]) }; }

  @Post('suggest-handle')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async suggestHandle(@Body() body: unknown) {
    const { display_name } = parse(registration.pick({ display_name: true }), body);
    const normalized = display_name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const stem = normalized || 'mwitu_user';
    const base = stem.length >= 3 ? stem.slice(0, 24) : stem + '_ke';
    const candidates = [base, ...Array.from({ length: 5 }, () =>
      base.slice(0, 17) + '_' + randomBytes(3).toString('hex'))];
    const { rows } = await db.query<{ handle: string }>('SELECT handle FROM users WHERE handle=ANY($1::text[])', [candidates]);
    const used = new Set(rows.map(row => row.handle));
    return { handle: candidates.find(candidate => !used.has(candidate)) ?? null };
  }

  @Post('register')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  async register(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { handle, display_name, password } = parse(registration, body);
    const { rows: [user] } = await db.query<Person>(`
      INSERT INTO users(handle,display_name,password_hash) VALUES ($1,$2,$3)
      ON CONFLICT(handle) DO NOTHING RETURNING id,handle,display_name`,
      [handle, display_name, await hashPassword(password)]);
    if (!user) throw new ConflictException('That handle is taken.');
    return loginSession(req, res, user);
  }

  @Post('login')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { handle, password } = parse(credentials, body);
    const { rows: [user] } = await db.query<Person & { password_hash: string }>(
      'SELECT id,handle,display_name,password_hash FROM users WHERE handle=$1', [handle]);
    if (!(await checkPassword(password, user?.password_hash)) || !user) {
      throw new UnauthorizedException('Check your handle and password.');
    }
    return loginSession(req, res, { id: user.id, handle: user.handle, display_name: user.display_name });
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies[cookie];
    if (typeof token === 'string') {
      await db.query('DELETE FROM sessions WHERE digest=$1', [digest(token)]);
      disconnectSession(token);
    }
    res.clearCookie(cookie, cookieOptions);
    return { ok: true };
  }
}
