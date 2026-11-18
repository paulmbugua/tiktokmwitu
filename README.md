
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

## Deploy on the VPS

Clone the [GitHub repository](https://github.com/paulmbugua/tiktokmwitu) and create a server-only `.env`. Set `POSTGRES_PASSWORD`, `MWITU_DOMAIN` to the DNS hostname, and `APP_ORIGIN` to its exact HTTPS URL. Point DNS to the VPS.

On a VPS where this app owns ports 80 and 443:

```sh
docker compose -f compose.yaml -f compose.production.yaml up -d --build
```

On Rivera’s VPS, use its existing Caddy so both apps can share the public ports:

1. Confirm the running Rivera Caddy is attached to `rivera_default` or set `RIVERA_EDGE_NETWORK` to one of its existing networks.
2. Run `docker compose -f compose.yaml -f compose.rivera.yaml up -d --build`.
3. Add the block from `deploy/Caddyfile.rivera.example` to Rivera’s Caddy configuration, using the real domain. Validate the file before reloading Caddy.
4. Check `/api/health` on the public domain. Sign in and publish a clip, then verify video playback and an inbox update from a second account.

Set up regular backups of PostgreSQL and the media volume before accepting public uploads. Keep one API replica with this configuration. The upload encoder and socket rooms are process-local. Review reports through PostgreSQL and remove flagged content before opening sign-ups broadly. Use the reports table to find the video and its reason. A moderator can remove a video by deleting its row and the matching `public/<video-id>.mp4` file from the media volume.

## Enable live broadcasts

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in the API environment and restart it. A public app needs a trusted `wss://` LiveKit endpoint. For a local server started with the LiveKit development defaults, use `ws://localhost:7880`, `devkey` and `secret` in native development. Keep development credentials off the public VPS. See the [LiveKit VPS setup guide](https://docs.livekit.io/transport/self-hosting/vm/) for media ports and TURN.

Sign in as the host, select Live, allow camera and microphone, then sign in from another browser profile to watch and send a chat message. Live chat is ephemeral.
