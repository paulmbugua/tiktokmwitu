
import { Body, ConflictException, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  checkPassword, cleanText, cookie, cookieOptions, db, digest, disconnectSession,
  handleSchema, hashPassword, identity, newSession, origin, parse, passwordSchema, type Person,
} from './infra';
import { beginGoogle, clearGoogleSignup, exchangeGoogle, googleAttempt, googleAvailability, googleSignup,
  pendingDigest, startGoogleAccount, verifyGoogleAndroid } from './google-auth';

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
  async me(@Req() req: Request) {
    const [user, signup] = await Promise.all([identity(req.cookies[cookie]), googleSignup(req)]);
    return { user, google: googleAvailability, googleSignup: signup };
  }

  @Post('google/start')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  beginWebGoogle(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { next } = parse(z.object({ next: z.string().max(400).optional() }), body);
    const url = beginGoogle(res, next);
    if (!url) throw new UnauthorizedException('Google sign-in is unavailable.');
    return { url };
  }

  @Get('google/callback')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const attempt = googleAttempt(req, res);
    const destination = new URL('/', origin);
    if (attempt) destination.search = attempt.next;
    destination.searchParams.set('google', 'error');
    const { code, state } = req.query;
    if (!attempt || typeof state !== 'string' || state !== attempt.state ||
        typeof code !== 'string' || code.length === 0 || code.length > 4096) {
      return res.redirect(303, destination.href);
    }
    try {
      const user = await startGoogleAccount(res, await exchangeGoogle(code, attempt));
      if (user) await loginSession(req, res, user);
      destination.searchParams.set('google', user ? 'signed-in' : 'choose-handle');
    } catch {
      // Google credentials and OAuth codes are never included in logs or errors.
    }
    return res.redirect(303, destination.href);
  }

  @Post('google/android')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  async androidGoogle(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { idToken } = parse(z.object({ idToken: z.string().min(200).max(8192) }), body);
    const profile = await verifyGoogleAndroid(idToken).catch(() => {
      throw new UnauthorizedException('Google could not verify this sign-in. Try again.');
    });
    const user = await startGoogleAccount(res, profile);
    if (user) return { user: await loginSession(req, res, user) };
    return { googleSignup: { display_name: profile.displayName } };
  }

  @Post('google/complete')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  async completeGoogle(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { handle, display_name } = parse(registration.omit({ password: true }), body);
    const pending = pendingDigest(req);
    if (!pending) throw new UnauthorizedException('Google sign-in expired. Sign in with Google again.');
    const client = await db.connect();
    let user: Person;
    try {
      await client.query('BEGIN');
      const { rows: [signup] } = await client.query<{ subject: string }>(
        'SELECT subject FROM google_signup WHERE digest=$1 AND expires_at>now() FOR UPDATE', [pending]);
      if (!signup) throw new UnauthorizedException('Google sign-in expired. Sign in with Google again.');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['google:' + signup.subject]);
      const { rows: [existing] } = await client.query<Person>(
        'SELECT u.id,u.handle,u.display_name FROM google_identities g JOIN users u ON u.id=g.user_id WHERE g.subject=$1', [signup.subject]);
      if (existing) {
        user = existing;
      } else {
        const { rows: [created] } = await client.query<Person>(`
          INSERT INTO users(handle,display_name,password_hash) VALUES ($1,$2,$3)
          ON CONFLICT(handle) DO NOTHING RETURNING id,handle,display_name`, [handle, display_name, await hashPassword(randomBytes(32).toString('hex'))]);
        if (!created) throw new ConflictException('That handle is taken. Choose another.');
        await client.query('INSERT INTO google_identities(subject,user_id) VALUES ($1,$2)', [signup.subject, created.id]);
        user = created;
      }
      await client.query('DELETE FROM google_signup WHERE digest=$1', [pending]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    clearGoogleSignup(res);
    return loginSession(req, res, user);
  }

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
    clearGoogleSignup(res);
    return { ok: true };
  }
}
