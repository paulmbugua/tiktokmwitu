import { createHash, randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Request, Response } from 'express';
import { cookieOptions, db, digest, type Person } from './infra';

const { GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, GOOGLE_WEB_REDIRECT_URI, GOOGLE_ANDROID_CLIENT_ID } = process.env;
const web = GOOGLE_WEB_CLIENT_ID && GOOGLE_WEB_CLIENT_SECRET && GOOGLE_WEB_REDIRECT_URI
  ? new OAuth2Client(GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, GOOGLE_WEB_REDIRECT_URI) : null;
const verifierClient = new OAuth2Client();
const cookiePrefix = cookieOptions.secure ? '__Host-' : '';
const googleAttemptCookie = cookiePrefix + 'mwitu_google_attempt';
const googlePendingCookie = cookiePrefix + 'mwitu_google_pending';
const tenMinutes = 600000;
const tokenFormat = /^[a-zA-Z0-9_-]{43}$/;
const randomToken = () => randomBytes(32).toString('base64url');

export const googleAvailability = { web: Boolean(web), android: Boolean(GOOGLE_ANDROID_CLIENT_ID) };
export const googleSchema = `
CREATE TABLE IF NOT EXISTS google_identities (
  subject text PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS google_signup (
  digest text PRIMARY KEY,
  subject text NOT NULL,
  display_name varchar(48) NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS google_signup_expiry ON google_signup(expires_at);
`;

type GooglePerson = { subject: string; displayName: string };
type Attempt = { state: string; nonce: string; verifier: string; next: string };

export function browserDestination(value: unknown) {
  const params = new URLSearchParams(typeof value === 'string' && value.length <= 400 ? value : '');
  const next = new URLSearchParams();
  const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const live = params.get('live') ?? '';
  if (/^(?:\d{6}|[a-f0-9]{16})$/i.test(live)) next.set('live', live);
  for (const key of ['v', 'topup', 'room']) {
    const candidate = params.get(key) ?? '';
    if (id.test(candidate)) next.set(key, candidate);
  }
  if (next.has('v')) {
    next.set('app', '1');
    if (params.get('action') === 'comments') next.set('action', 'comments');
  }
  const browse = params.get('browse') ?? '';
  if (['live', 'post', 'inbox', 'account', 'videos', 'wallet'].includes(browse)) next.set('browse', browse);
  return next.toString();
}

export function beginGoogle(res: Response, next: unknown) {
  if (!web) return null;
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const attempt: Attempt = { state, nonce, verifier, next: browserDestination(next) };
  res.cookie(googleAttemptCookie, JSON.stringify(attempt), { ...cookieOptions, maxAge: tenMinutes });
  const url = new URL(web.generateAuthUrl({
    access_type: 'online', prompt: 'select_account', scope: ['openid', 'profile', 'email'],
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: CodeChallengeMethod.S256,
  }));
  url.searchParams.set('nonce', nonce);
  return url.href;
}

export function googleAttempt(req: Request, res: Response): Attempt | null {
  const cookie = req.cookies[googleAttemptCookie];
  res.clearCookie(googleAttemptCookie, cookieOptions);
  if (typeof cookie !== 'string') return null;
  try {
    const { state, nonce, verifier, next } = JSON.parse(cookie) as Attempt;
    if (![state, nonce, verifier].every(value => typeof value === 'string' && tokenFormat.test(value))) return null;
    return { state, nonce, verifier, next: browserDestination(next) };
  } catch {
    return null;
  }
}

async function googlePerson(token: string, audience: string, nonce?: string): Promise<GooglePerson> {
  const ticket = await verifierClient.verifyIdToken({ idToken: token, audience });
  const claims = ticket.getPayload() as (ReturnType<typeof ticket.getPayload> & { nonce?: string });
  if (!claims?.sub || claims.sub.length > 255 || !claims.email_verified || (nonce && claims.nonce !== nonce)) {
    throw new Error('Invalid Google identity');
  }
  const displayName = (claims.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 48) || 'Mwitu creator';
  return { subject: claims.sub, displayName };
}

export async function exchangeGoogle(code: string, attempt: Attempt) {
  if (!web || !GOOGLE_WEB_CLIENT_ID) throw new Error('Google web sign-in unavailable');
  const { tokens } = await web.getToken({ code, codeVerifier: attempt.verifier });
  if (!tokens.id_token) throw new Error('Missing Google identity token');
  return googlePerson(tokens.id_token, GOOGLE_WEB_CLIENT_ID, attempt.nonce);
}

export function verifyGoogleAndroid(token: string) {
  if (!GOOGLE_ANDROID_CLIENT_ID) throw new Error('Google Android sign-in unavailable');
  return googlePerson(token, GOOGLE_ANDROID_CLIENT_ID);
}

export async function startGoogleAccount(res: Response, profile: GooglePerson) {
  const { rows: [user] } = await db.query<Person>(
    'SELECT u.id,u.handle,u.display_name FROM google_identities g JOIN users u ON u.id=g.user_id WHERE g.subject=$1', [profile.subject]);
  if (user) {
    clearGoogleSignup(res);
    return user;
  }
  const token = randomToken();
  await db.query('INSERT INTO google_signup(digest,subject,display_name) VALUES ($1,$2,$3)',
    [digest(token), profile.subject, profile.displayName]);
  res.cookie(googlePendingCookie, token, { ...cookieOptions, maxAge: tenMinutes });
  return undefined;
}

export function pendingDigest(req: Request) {
  const token = req.cookies[googlePendingCookie];
  return typeof token === 'string' && tokenFormat.test(token) ? digest(token) : null;
}

export async function googleSignup(req: Request) {
  const pending = pendingDigest(req);
  if (!pending) return null;
  const { rows: [signup] } = await db.query<{ display_name: string }>(
    'SELECT display_name FROM google_signup WHERE digest=$1 AND expires_at>now()', [pending]);
  return signup ?? null;
}

export function clearGoogleSignup(res: Response) {
  res.clearCookie(googlePendingCookie, cookieOptions);
}
