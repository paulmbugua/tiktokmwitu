
# Tiktok mwitu

Tiktok mwitu is a Kenya-focused short-video app. Next.js serves the mobile and desktop interface, NestJS serves the API and Socket.IO, and PostgreSQL stores accounts, sessions, videos, follows, likes, comments, messages and reports. FFmpeg creates browser-playable MP4s with a capped bitrate. Authenticated users can host and watch LiveKit broadcasts with room chat when a LiveKit endpoint is configured.

The For You feed is chronological. Discover searches captions, creator names, handles and counties. Following uses each account’s actual follow graph. New video activity and private inbox changes arrive over WebSocket. Video bytes are persisted in a Docker volume.

## Run on your machine

Use Node 22.22 or later on the Node 22 line, and Docker Compose 2.24.4 or newer for the override files.

1. Copy `.env.example` to `.env`. Set a strong, unique `POSTGRES_PASSWORD` and use `APP_ORIGIN=http://localhost:8092`.
2. Run `docker compose up -d --build`.
3. Open [Tiktok mwitu](http://localhost:8092) and check [API health](http://localhost:8092/api/health).

For native development, install PostgreSQL and FFmpeg, create a database, and set `DATABASE_URL` in `.env`. Use `APP_ORIGIN=http://localhost:3000`. Run `npm ci`, then launch `npm run dev:api` and `npm run dev:web` in separate terminals. Open `http://localhost:3000`. Next.js proxies HTTP requests to the API. The browser connects to Socket.IO directly on port 4000 in development. Set `INTERNAL_API_URL` and `NEXT_PUBLIC_REALTIME_URL` if you change the API port. Production uses Caddy for same-origin WebSockets.

The empty feed fills when users publish. Use two accounts in separate browser profiles to try private messaging and see likes or comments update in real time.

## Production hostnames

- `https://tiktokmwitu.co.ke` serves the short-video app on Cloudflare Workers Static Assets.
- `https://admin.tiktokmwitu.co.ke` serves the moderation interface from the same Worker. NestJS verifies moderator permissions before returning reports or accepting actions.
- `https://api.tiktokmwitu.co.ke` reaches NestJS, uploaded media, and Socket.IO on Rivera’s VPS over Cloudflare Tunnel.

### Cloudflare DNS and web deployment

1. Add `tiktokmwitu.co.ke` as a Cloudflare zone. Import and verify existing DNS records, including email records, before updating nameservers at the current registrar. Cloudflare DNS and Workers can be used while registration stays with the current registrar. Check [registrar transfer eligibility](https://developers.cloudflare.com/registrar/top-level-domains/) separately.
2. Publish `api.tiktokmwitu.co.ke` through the existing Rivera Production tunnel. Cloudflare creates a proxied CNAME for the route. Replace any conflicting legacy `api` record only after verifying it belongs to this app.
3. With an authenticated Wrangler session for the account that owns the zone, run `npm ci` followed by `npm run deploy:cloudflare -w web`. Wrangler builds the static Next.js app and attaches the apex and admin hostnames as Worker Custom Domains. Resolve any existing DNS record conflicts for those two hostnames before first attaching them.

The app makes credentialed HTTPS requests directly to the API and opens Socket.IO there over WSS. The API accepts the two web origins and stores sessions in an API-host-only cookie. Keep all three public hostnames on HTTPS.

### Deploy the API on Rivera’s VPS

Clone the [GitHub repository](https://github.com/paulmbugua/tiktokmwitu) and copy `.env.example` to a server-only `.env`. Set a unique `POSTGRES_PASSWORD` and these two origins:

```dotenv
APP_ORIGIN=https://tiktokmwitu.co.ke
ADMIN_ORIGIN=https://admin.tiktokmwitu.co.ke
```

1. Run `docker compose -f compose.yaml -f compose.tunnel.yaml up -d --build` to start PostgreSQL and NestJS. The API joins the connector’s private `rivera_edge` network and publishes no host port. Set `RIVERA_TUNNEL_NETWORK` if the connector moves to a different private network.
2. Check that Compose reports the API healthy. From the connector network the service address is `http://tiktokmwitu-api:4000/api/health`.
3. In Cloudflare Zero Trust, open `Rivera Production` and publish `api.tiktokmwitu.co.ke` to `http://tiktokmwitu-api:4000`. Keep the other published hostnames intact.
4. Check `https://api.tiktokmwitu.co.ke/api/health`. Sign in and publish a clip from the Cloudflare site, then verify playback and an inbox update from a second account.

### Provision moderators

Create the moderator’s account through the public site. Confirm they control that account, then obtain the immutable user ID from PostgreSQL:

```sh
docker compose exec db psql -U mwitu -d mwitu -c "SELECT id,handle FROM users WHERE handle='moderator_handle';"
```

Add the verified ID to `ADMIN_USER_IDS` in the VPS `.env`. Separate multiple IDs with commas and rerun the tunnel Compose command to apply the change. That account can log in at `https://admin.tiktokmwitu.co.ke`, inspect reported videos, dismiss reports, or remove a video. Decisions are recorded in `moderation_actions`. Leaving the allowlist empty disables moderator access. For native development, visit `http://localhost:3000/admin` with a local account ID allowlisted.

Back up PostgreSQL and the media volume together. Keep one API replica with this configuration because the upload encoder and socket rooms are process-local.
The tunnel deployment reserves 1 GiB of free VPS space when accepting new video uploads. Set `MWITU_PRIVATE_SUBNET` to an unused subnet if the app's private bridge conflicts with another network.

## Enable live broadcasts

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in the API environment and restart it. A public app needs a trusted `wss://` LiveKit endpoint. For a local server started with the LiveKit development defaults, use `ws://localhost:7880`, `devkey` and `secret` in native development. Keep development credentials off the public VPS. See the [LiveKit VPS setup guide](https://docs.livekit.io/transport/self-hosting/vm/) for media ports and TURN.

Sign in as the host, select Live, allow camera and microphone, then sign in from another browser profile to watch and send a chat message.

## 1v1 LIVE and room moderation

Use separate signed-in browser profiles for the host, challenger, and viewers. The challenger first joins the host’s broadcast as a viewer. The host invites their handle, and the challenger accepts and shares their camera. The match shows both feeds, counts down from five seconds, then runs for three minutes. Each connected viewer gets one free vote. The API records scores, a winner or draw, and forfeits. A creator can start another match from the same broadcast.

Open **Moderation** inside a broadcast to appoint room moderators, turn viewer chat on or off, filter keywords, pin or remove messages, apply or lift chat timeouts, ban or unban participants, and review reports and the action log. Host reports go directly to platform moderators. The admin dashboard can review LIVE reports and end a broadcast. Rules and roles apply to that broadcast. Chat history and actions are stored in PostgreSQL.
