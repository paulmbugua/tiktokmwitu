import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const dbUrl = new URL(process.env.MWITU_LOAD_DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost'].includes(dbUrl.hostname), 'Use a local test PostgreSQL server.');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const total = Number(process.env.MWITU_LOAD_VIEWERS ?? 18000);
const clients = Number(process.env.MWITU_LOAD_CONCURRENCY ?? 160);
const listeners = Number(process.env.MWITU_LOAD_STREAMS ?? 1000);
assert(Number.isInteger(total) && total >= 10 && total <= 50000);
assert(Number.isInteger(clients) && clients >= 1 && clients <= 500);
assert(Number.isInteger(listeners) && listeners >= 0 && listeners <= 20000);
const base = 'http://127.0.0.1:4473';
const invitation = '/live/handoff/624190';
const database = 'mwitu_stream_' + randomBytes(6).toString('hex');
const host = randomUUID();
const room = randomUUID();
const input = randomBytes(16).toString('hex');
const accounts = Array.from({ length: Math.min(total, 500) }, () => ({
  userId: randomUUID(), token: randomBytes(32).toString('base64url'),
}));
const admin = new pg.Client({ connectionString: dbUrl.toString() });
const data = new URL(dbUrl);
data.pathname = '/' + database;
const pool = new pg.Pool({ connectionString: data.toString() });
const folder = await mkdtemp(join(tmpdir(), 'mwitu-stream-'));
const rtc = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const payload = req.url.endsWith('/ListRooms') ? { rooms: [{ name: 'mwitu-' + room }] } :
    req.url.endsWith('/ListParticipants') ? { participants: [{ identity: host }] } : {};
  res.end(JSON.stringify(payload));
});
let api;
let created = false;
const samples = new Map();
const streams = new AbortController();

async function guestEvents(cookie, index) {
  const ip = '10.2.' + (1 + Math.floor(index / 254) % 254) + '.' + (1 + index % 254);
  const response = await fetch(base + '/api' + invitation + '/events', {
    headers: { 'cf-connecting-ip': ip, cookie }, signal: streams.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return async function next() {
    while (true) {
      const delimiter = buffer.indexOf('\n\n');
      if (delimiter !== -1) {
        const event = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        const line = event.split('\n').find(line => line.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
      } else {
        const result = await reader.read();
        assert(!result.done, 'Audience event stream ended early.');
        buffer += result.value;
      }
    }
  };
}

async function call(path, { cookie = '', index = 0, body, method = body === undefined ? 'GET' : 'POST', statuses = [200, 201] } = {}) {
  const started = performance.now();
  const ip = '10.' + (1 + Math.floor(index / 64516)) + '.' + (1 + Math.floor(index / 254) % 254) + '.' + (1 + index % 254);
  const response = await fetch(base + '/api' + path, {
    method, headers: { 'cf-connecting-ip': ip, 'x-mwitu-request': '1', cookie, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const value = await response.json();
  assert(statuses.includes(response.status), method + ' ' + path + ' ' + response.status + ': ' + JSON.stringify(value));
  const label = method + ' ' + path;
  const metrics = samples.get(label) ?? [];
  metrics.push(performance.now() - started);
  samples.set(label, metrics);
  const cookies = response.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ');
  return { value, cookie: cookies || cookie };
}
async function concurrent(count, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, clients) }, async () => {
    while (next < count) await run(next++);
  }));
}
async function ready() {
  let status;
  for (let i = 0; i < 160; i++) {
    const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2500) }).catch(() => null);
    if (response?.ok) return;
    if (response) status = response.status + ' ' + await response.text();
    if (api.exitCode !== null || api.signalCode) break;
    await sleep(250);
  }
  throw new Error('Local API did not start. ' + (status ?? api.exitCode ?? api.signalCode ?? 'No HTTP response.'));
}

try {
  await admin.connect();
  await admin.query('CREATE DATABASE ' + database);
  created = true;
  await new Promise(resolve => rtc.listen(0, '127.0.0.1', resolve));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  api = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: data.toString(), API_PORT: '4473', API_HOST: '127.0.0.1', MEDIA_DIR: folder,
      TRUST_CLOUDFLARE_TUNNEL: 'true', APP_ORIGIN: base, LIVEKIT_URL: 'ws://127.0.0.1:' + rtc.address().port,
      LIVEKIT_API_KEY: 'mwitu-load', LIVEKIT_API_SECRET: 'local-fixture-only',
      CF_STREAM_ACCOUNT_ID: input, CF_STREAM_API_TOKEN: 'fixture-token', CF_STREAM_SIGNING_KEY_ID: input,
      CF_STREAM_PLAYBACK_HOST: 'customer-loadtest.cloudflarestream.com',
      CF_STREAM_SIGNING_KEY_JWK: Buffer.from(JSON.stringify(privateKey.export({ format: 'jwk' }))).toString('base64'),
    },
  });
  api.stdout.on('data', data => { if (process.env.MWITU_LOAD_VERBOSE) process.stdout.write(data); });
  api.stderr.pipe(process.stderr);
  await ready();
  await pool.query("INSERT INTO users(id,handle,display_name,password_hash) VALUES($1,'load_host','Load host','fixture')", [host]);
  await pool.query('INSERT INTO live_rooms(id,host_id,online_at) VALUES($1,$2,now())', [room, host]);
  const plan = await pool.query('INSERT INTO live_invite_plans(user_id,coins,request_id) VALUES($1,1000,$2) RETURNING id', [host, randomUUID()]);
  await pool.query("INSERT INTO live_invite_passes(code,room_id,plan_id,request_id,expires_at) VALUES('624190',$1,$2,$3,now()+interval '1 hour')", [room, plan.rows[0].id, randomUUID()]);
  // Seed media readiness and keep actual provider requests out of the load test.
  await pool.query("INSERT INTO live_streams(room_id,input_id,available,checked_at) VALUES($1,$2,true,'infinity')", [room, input]);
  await pool.query("INSERT INTO users(id,handle,display_name,password_hash) SELECT id,'load_'||ord,'Load viewer '||ord,'fixture' FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id,ord)", [accounts.map(a => a.userId)]);
  await pool.query("INSERT INTO sessions(user_id,digest,expires_at) SELECT id,digest,now()+interval '1 hour' FROM unnest($1::uuid[],$2::text[]) AS s(id,digest)", [
    accounts.map(a => a.userId), accounts.map(a => createHash('sha256').update(a.token).digest('hex')),
  ]);
  const guestCookies = new Array(total);
  const start = performance.now();
  await concurrent(total, async index => {
    if (index < accounts.length) {
      const cookie = 'mwitu_session=' + accounts[index].token;
      await call(invitation, { cookie, index });
      const { value } = await call(invitation + '/join', { cookie, index, method: 'POST' });
      assert.equal(value.transport, 'stream');
      assert.equal(value.token, undefined);
      guestCookies[index] = cookie;
    } else {
      const preview = await call(invitation, { index });
      const joined = await call(invitation + '/watch', { index, method: 'POST', cookie: preview.cookie });
      assert.equal(joined.value.transport, 'stream');
      assert.equal(joined.value.token, undefined);
      guestCookies[index] = joined.cookie;
    }
  });
  const joinSeconds = (performance.now() - start) / 1000;
  await concurrent(accounts.length, async index => {
    await call('/live/' + room + '/chat', { index, cookie: guestCookies[index], body: { body: 'Load chat ' + index } });
  });
  const chat = await pool.query('SELECT count(*)::int AS count FROM live_messages WHERE room_id=$1', [room]);
  assert.equal(chat.rows[0].count, accounts.length);
  const pollStart = performance.now();
  await concurrent(total, async index => {
    const path = index < accounts.length ? '/live/' + room + '/state' : invitation + '/state';
    const { value } = await call(path, { index, cookie: guestCookies[index] });
    assert.equal(value.room.id, room);
    assert.equal(value.messages.length, Math.min(accounts.length, 60));
    assert.match(value.playback, /^https:\/\/customer-loadtest\.cloudflarestream\.com\/.+\/manifest\/video\.m3u8$/);
  });
  const pollSeconds = (performance.now() - pollStart) / 1000;
  const listenersToOpen = Math.min(listeners, total - accounts.length);
  if (listenersToOpen) {
    const readers = [];
    await concurrent(listenersToOpen, async index => {
      const next = await guestEvents(guestCookies[accounts.length + index], index);
      assert.equal((await next()).room.id, room);
      readers.push(next);
    });
    const marker = 'Chat fan-out marker';
    const fanoutStart = performance.now();
    const delivered = readers.map(async next => {
      while (!(await next()).messages.some(message => message.body === marker)) {}
      return performance.now() - fanoutStart;
    });
    await call('/live/' + room + '/chat', { cookie: guestCookies[0], body: { body: marker } });
    let timeout;
    try {
      const result = await Promise.race([Promise.all(delivered), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Chat fan-out timed out.')), 20000);
      })]);
      console.log('Chat pushed to ' + result.length + ' open guest feeds in ' + Math.round(Math.max(...result)) + 'ms');
    } finally {
      clearTimeout(timeout);
      streams.abort();
    }
  }
  await call('/live/' + room + '/stage-connection', { cookie: guestCookies[0], method: 'POST', statuses: [403] });
  await pool.query('INSERT INTO live_stage_seats(room_id,user_id) VALUES($1,$2)', [room, accounts[0].userId]);
  const stage = await call('/live/' + room + '/stage-connection', { cookie: guestCookies[0], method: 'POST' });
  assert.equal(stage.value.transport, 'livekit');
  assert(stage.value.token);
  if (total > accounts.length) {
    await pool.query('UPDATE live_rooms SET guest_access=false WHERE id=$1', [room]);
    const blocked = await call(invitation + '/state', { index: total - 1, cookie: guestCookies.at(-1) });
    assert.equal(blocked.value.playback, undefined);
    assert.equal(blocked.value.messages.length, 0);
  }
  for (const [route, values] of samples) {
    values.sort((a, b) => a - b);
    const percentile = p => Math.round(values[Math.ceil(values.length * p) - 1]);
    console.log(route.replace(room, ':room'), values.length, 'p50=' + percentile(.50) + 'ms', 'p95=' + percentile(.95) + 'ms', 'p99=' + percentile(.99) + 'ms');
  }
  console.log(JSON.stringify({ viewers: total, authenticated: accounts.length, chats: accounts.length, concurrency: clients,
    joinSeconds: +joinSeconds.toFixed(2), pollSeconds: +pollSeconds.toFixed(2) }));
} finally {
  streams.abort();
  if (api && api.exitCode === null) {
    const stopped = new Promise(resolve => api.once('exit', resolve));
    api.kill();
    await stopped;
  }
  rtc.close();
  await pool.end();
  if (created) await admin.query('DROP DATABASE ' + database + ' WITH (FORCE)');
  await admin.end();
  await rm(folder, { recursive: true });
}
