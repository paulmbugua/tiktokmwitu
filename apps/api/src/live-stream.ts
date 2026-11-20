import { createHmac, createPrivateKey, sign } from 'node:crypto';
import { EgressClient, EncodingOptions, StreamOutput, StreamProtocol } from 'livekit-server-sdk';
import type { PoolClient } from 'pg';
import { db, origin } from './infra';

const account = process.env.CF_STREAM_ACCOUNT_ID ?? '';
const credential = process.env.CF_STREAM_API_TOKEN;
const host = process.env.CF_STREAM_PLAYBACK_HOST ?? '';
const keyId = process.env.CF_STREAM_SIGNING_KEY_ID ?? '';
const encodedKey = process.env.CF_STREAM_SIGNING_KEY_JWK;
const configured = /^[a-f0-9]{32}$/.test(account) && credential &&
  /^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(host) && /^[a-f0-9]{32}$/.test(keyId) && encodedKey;
const signingKey = configured ? createPrivateKey({
  key: JSON.parse(Buffer.from(encodedKey!, 'base64').toString('utf8')), format: 'jwk',
}) : null;
const internal = process.env.LIVEKIT_INTERNAL_URL || process.env.LIVEKIT_URL;
const bunnyHost = process.env.BUNNY_LIVE_HOST ?? 'mwitulive.b-cdn.net';
const bunnyKey = process.env.BUNNY_VIEWER_TOKEN_KEY;
const publisherPassword = process.env.BUNNY_RTMP_PASSWORD;
const bunnyConfigured = !!(bunnyKey && publisherPassword && /^[a-z0-9-]+\.b-cdn\.net$/.test(bunnyHost));
type Provider = 'bunny' | 'cloudflare';
const preferred: Provider = process.env.LIVE_AUDIENCE_PROVIDER === 'bunny' ? 'bunny' : 'cloudflare';
const egress = (signingKey || bunnyConfigured) && internal && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
  ? new EgressClient(internal, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { requestTimeout: 30 }) : null;
export const streamEnabled = !!egress && (preferred === 'bunny' ? bunnyConfigured : !!signingKey);
export const streamSchema = `
CREATE TABLE IF NOT EXISTS live_streams (
  room_id uuid PRIMARY KEY REFERENCES live_rooms ON DELETE CASCADE,
  input_id text,
  egress_id text,
  checked_at timestamptz NOT NULL DEFAULT '-infinity',
  available boolean NOT NULL DEFAULT false
);
ALTER TABLE live_streams ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'cloudflare';
CREATE INDEX IF NOT EXISTS live_streams_due ON live_streams(checked_at);
`;

type Input = { uid: string; rtmps: { url: string; streamKey: string } };
export type StreamSource = { provider: Provider | null; room_id: string; input_id: string | null };
type StreamRow = StreamSource & { egress_id: string | null; ended_at: Date | null };
const idPattern = /^[a-f0-9]{32}$/;
const roomName = (id: string) => 'mwitu-' + id;

async function cloud<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/stream${path}`, {
    method, headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
  if (method === 'DELETE' && response.status === 404) return undefined as T;
  if (!response.ok) throw new Error('Cloudflare Stream ' + response.status);
  const data = await response.json() as { success: boolean; result: T };
  if (!data.success) throw new Error('Cloudflare Stream request failed');
  return data.result;
}

// Token windows are identical across viewers, so one signature can serve the whole audience.
const tokens = new Map<string, { epoch: number; url: string }>();
export function bunnyPlaybackUrl(host: string, key: string, roomId: string, expires: number) {
  const path = `/${roomName(roomId)}/`;
  const token = createHmac('sha256', key).update(path + expires + 'token_path=' + path).digest('base64url');
  return `https://${host}/bcdn_token=HS256-${token}&expires=${expires}&token_path=${encodeURIComponent(path)}${path}index.m3u8`;
}

export function playback({ provider, room_id: roomId, input_id: input }: StreamSource) {
  if (provider === 'bunny') {
    if (!bunnyConfigured || !bunnyKey) return null;
    // Sign for two one-minute windows so clients can refresh before expiration.
    return bunnyPlaybackUrl(bunnyHost, bunnyKey, roomId, (Math.floor(Date.now() / 60000) + 2) * 60);
  }
  if (!signingKey || !input || !idPattern.test(input)) return null;
  const epoch = Math.floor(Date.now() / 300000);
  const prior = tokens.get(input);
  if (prior?.epoch === epoch) return prior.url;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = encode({ alg: 'RS256', typ: 'JWT', kid: keyId }) + '.' +
    encode({ sub: input, kid: keyId, exp: (epoch + 2) * 300 });
  const token = claims + '.' + sign('RSA-SHA256', Buffer.from(claims), signingKey).toString('base64url');
  const url = `https://${host}/${token}/manifest/video.m3u8`;
  if (tokens.size >= 256) tokens.clear();
  tokens.set(input, { epoch, url });
  return url;
}

export async function enqueueStream(client: PoolClient, id: string) {
  if (streamEnabled) {
    await client.query('INSERT INTO live_streams(room_id,provider) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, preferred]);
  }
}

async function update(row: StreamRow) {
  const { room_id: id } = row;
  const name = roomName(id);
  const bunny = row.provider === 'bunny';
  if (bunny ? !bunnyConfigured : !signingKey) return;
  if (row.ended_at) {
    for (const output of await egress!.listEgress({ roomName: name, active: true })) {
      if (output.egressId === row.egress_id || (bunny && !row.egress_id)) await egress!.stopEgress(output.egressId);
    }
    if (row.input_id) {
      await cloud('/live_inputs/' + row.input_id, 'PUT', { enabled: false });
      tokens.delete(row.input_id);
      await cloud('/live_inputs/' + row.input_id, 'DELETE');
    }
    await db.query(`UPDATE live_streams SET input_id=NULL,egress_id=NULL,available=false,checked_at='infinity'
      WHERE room_id=$1`, [id]);
    return;
  }
  let inputId = row.input_id;
  let input: Input | undefined;
  if (!bunny && !inputId) {
    input = await cloud<Input>('/live_inputs', 'POST', {
      meta: { name, roomId: id }, preferLowLatency: true,
      recording: { mode: 'automatic', requireSignedURLs: true, allowedOrigins: ['tiktokmwitu.co.ke', 'www.tiktokmwitu.co.ke'] },
      deleteRecordingAfterDays: 30,
    });
    if (!idPattern.test(input.uid)) throw new Error('Unexpected Stream input identifier');
    inputId = input.uid;
    await db.query('UPDATE live_streams SET input_id=$2 WHERE room_id=$1', [id, inputId]);
  }
  const outputs = await egress!.listEgress({ roomName: name, active: true });
  const active = outputs.find(output => output.egressId === row.egress_id) ?? outputs[0];
  if (!active) {
    let destination: string;
    if (bunny) {
      destination = `rtmp://bunny-media:1935/live/${name}?user=mwitu&pass=${encodeURIComponent(publisherPassword!)}`;
    } else {
      input ??= await cloud<Input>('/live_inputs/' + inputId);
      const ingest = new URL(input.rtmps.url);
      if (ingest.protocol !== 'rtmps:' || ingest.hostname !== 'live.cloudflare.com' ||
          !/^[\w-]+$/.test(input.rtmps.streamKey)) throw new Error('Unexpected Stream ingest destination');
      destination = ingest.href.replace(/\/$/, '') + '/' + input.rtmps.streamKey;
    }
    const started = await egress!.startRoomCompositeEgress(name,
      new StreamOutput({ protocol: StreamProtocol.RTMP, urls: [destination] }),
      { layout: 'grid', encodingOptions: new EncodingOptions({
        width: 720, height: 1280, framerate: 24, videoBitrate: 2400, audioBitrate: 96, keyFrameInterval: 2,
      }) });
    await db.query('UPDATE live_streams SET egress_id=$2,available=false WHERE room_id=$1', [id, started.egressId]);
    return;
  }
  const options = { headers: { Origin: origin, Referer: origin + '/' }, signal: AbortSignal.timeout(5000) };
  const manifest = await fetch(playback({ ...row, input_id: inputId })!, options);
  let live = manifest.ok && (await manifest.text()).startsWith('#EXTM3U');
  if (!manifest.ok) await manifest.body?.cancel();
  if (bunny && live) {
    const unsigned = await fetch(`https://${bunnyHost}/${name}/index.m3u8`, options);
    await unsigned.body?.cancel();
    live = unsigned.status === 403 || unsigned.status === 401;
  }
  await db.query('UPDATE live_streams SET egress_id=$2,available=$3 WHERE room_id=$1', [id, active.egressId, live]);
}

let sweeping = false;
export async function reconcileStreams() {
  if (!egress || sweeping) return;
  sweeping = true;
  try {
    const { rows } = await db.query<StreamRow>(`
      UPDATE live_streams s SET checked_at=now() FROM live_rooms r
      WHERE s.room_id=r.id AND s.room_id IN (
        SELECT room_id FROM live_streams WHERE checked_at<now()-interval '10 seconds'
        ORDER BY checked_at LIMIT 8
      ) RETURNING s.room_id,s.input_id,s.egress_id,s.provider,r.ended_at`);
    await Promise.all(rows.map(row => update(row).catch(async () => {
      // Provider errors may include RTMPS credentials. Log only the room identifier.
      console.warn('LIVE audience delivery will retry', row.room_id);
      if (row.provider === 'bunny') await db.query('UPDATE live_streams SET available=false WHERE room_id=$1', [row.room_id]);
    })));
  } catch {
    console.warn('LIVE audience reconciliation will retry');
  } finally { sweeping = false; }
}
