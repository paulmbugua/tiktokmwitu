
# Tiktok mwitu

Tiktok mwitu is a Kenya-focused short-video app. Next.js serves the mobile and desktop interface, NestJS serves the API and Socket.IO, and PostgreSQL stores accounts, sessions, videos, follows, likes, comments, messages and reports. FFmpeg creates browser-playable MP4s with a capped bitrate. Authenticated users can host and watch LiveKit broadcasts with room chat when a LiveKit endpoint is configured.

The For You feed is chronological. Discover searches captions, creator names, handles and counties. Following uses each account’s actual follow graph. New video activity and private inbox changes arrive over WebSocket. Production clips are stored in Cloudflare R2. Local clips use the development media directory or Docker volume.

## Run on your machine

Use Node 22.22 or later on the Node 22 line, and Docker Compose 2.24.4 or newer for the override files.

1. Copy `.env.example` to `.env`. Set a strong, unique `POSTGRES_PASSWORD` and use `APP_ORIGIN=http://localhost:8092`.
2. Run `docker compose up -d --build`.
3. Open [Tiktok mwitu](http://localhost:8092) and check [API health](http://localhost:8092/api/health).

For native development, install PostgreSQL and FFmpeg, create a database, and set `DATABASE_URL` in `.env`. Use `APP_ORIGIN=http://localhost:3000`. Run `npm ci`, then launch `npm run dev:api` and `npm run dev:web` in separate terminals. Open `http://localhost:3000`. Next.js proxies HTTP requests to the API. The browser connects to Socket.IO directly on port 4000 in development. Set `INTERNAL_API_URL` and `NEXT_PUBLIC_REALTIME_URL` if you change the API port. Production uses Caddy for same-origin WebSockets.

The empty feed fills when users publish. Use two accounts in separate browser profiles to try private messaging and see likes or comments update in real time.

## Production hostnames

- `https://tiktokmwitu.co.ke` serves the short-video app on Cloudflare Workers Static Assets.
- `https://www.tiktokmwitu.co.ke` redirects to `https://tiktokmwitu.co.ke` and preserves paths and query strings.
- `https://admin.tiktokmwitu.co.ke` serves the moderation interface from the same Worker. NestJS verifies moderator permissions before returning reports or accepting actions.
- `https://api.tiktokmwitu.co.ke` reaches NestJS, uploaded media, and Socket.IO on Rivera’s VPS over Cloudflare Tunnel.

### Cloudflare DNS and web deployment

1. Add `tiktokmwitu.co.ke` as a Cloudflare zone. Import and verify existing DNS records, including email records, before updating nameservers at the current registrar. Cloudflare DNS and Workers can be used while registration stays with the current registrar. Check [registrar transfer eligibility](https://developers.cloudflare.com/registrar/top-level-domains/) separately.
2. Publish `api.tiktokmwitu.co.ke` through the existing Rivera Production tunnel. Cloudflare creates a proxied CNAME for the route. Replace any conflicting legacy `api` record only after verifying it belongs to this app.
3. With an authenticated Wrangler session for the account that owns the zone, run `npm ci` followed by `npm run deploy:cloudflare -w web`. Wrangler builds the static Next.js app and attaches the apex and admin hostnames as Worker Custom Domains. Resolve any existing DNS record conflicts for those two hostnames before first attaching them.

The app makes credentialed HTTPS requests directly to the API and opens Socket.IO there over WSS. The API accepts the two web origins and stores sessions in an API-host-only cookie. Use HTTPS for all public hostnames.

Run `npm run deploy:www -w web` to deploy the separate Cloudflare Worker for the `www` redirect.

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

Back up PostgreSQL and the media it references. Keep one API replica with this configuration because the upload encoder and socket rooms are process-local. Set `MWITU_PRIVATE_SUBNET` to an unused subnet if the app's private bridge conflicts with another network.

### Production clip storage

The web Worker binds to the private R2 bucket `tiktokmwitu-images`. Set `MEDIA_STORAGE_SECRET` to the same generated secret in the Worker and the VPS API, and set `R2_MEDIA_ORIGIN=https://tiktokmwitu.co.ke` on the VPS. Set the Worker secret with `npm exec -w web -- wrangler secret put MEDIA_STORAGE_SECRET`. The API transcodes in the tunnel deployment's bounded temporary filesystem and stores the result under `videos/` in R2. The existing API media URL checks whether the video still exists before issuing an expiring playback redirect. The Worker supports byte ranges for seeking. Video removal queues object cleanup if R2 is temporarily unavailable. Clips originally stored locally continue using their local files until migrated.

## Enable live broadcasts

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in the API environment and restart it. A public app needs a trusted `wss://` LiveKit endpoint. For a local server started with the LiveKit development defaults, use `ws://localhost:7880`, `devkey` and `secret` in native development. Keep development credentials off the public VPS. See the [LiveKit VPS setup guide](https://docs.livekit.io/transport/self-hosting/vm/) for media ports and TURN.

For the self-hosted VPS setup, use `compose.livekit.yaml` with `compose.yaml` and `compose.tunnel.yaml`. Save the private server config in `secrets/livekit.yaml` with port 7880, TCP 7881, UDP mux 7882, `rtc.use_external_ip: false`, the public VPS IP as `rtc.node_ip`, and the API key mapped to a generated secret under `keys`. Set `rtc.ips.includes` to the app's private Docker subnet (`10.253.74.0/28` by default) so media uses the interface behind the published ports. Set `LIVEKIT_BIND_IP` to the VPS public IPv4, `LIVEKIT_INTERNAL_URL=http://tiktokmwitu-livekit:7880`, and `LIVEKIT_URL=wss://api.tiktokmwitu.co.ke`. Precede the general API ingress with an API-host tunnel rule matching `^/rtc(/|$)` and targeting `http://tiktokmwitu-livekit:7880`. Signaling uses the existing tunnel. WebRTC media connects to TCP 7881 or UDP 7882 on the VPS. LiveKit's administrative HTTP API stays on the Docker network.

Sign in as the host, select Live, allow camera and microphone, then sign in from another browser profile to watch and send a chat message.

## 1v1 LIVE and room moderation

Use separate signed-in browser profiles for the host, challenger, and viewers. The challenger first joins the host’s broadcast as a viewer. The host invites their handle, and the challenger accepts and shares their camera. The match shows both feeds, counts down from five seconds, then runs for three minutes. Each connected viewer gets one free vote. The API records scores, a winner or draw, and forfeits. A creator can start another match from the same broadcast.

Open **Moderation** inside a broadcast to appoint room moderators, turn viewer chat on or off, filter keywords, pin or remove messages, apply or lift chat timeouts, ban or unban participants, and review reports and the action log. Host reports go directly to platform moderators. The admin dashboard can review LIVE reports and end a broadcast. Rules and roles apply to that broadcast. Chat history and actions are stored in PostgreSQL.

### Bring an audience to Tiktok mwitu

Start a LIVE and open **Share LIVE**. Activate a seven-day invite plan with 1,000 coins for five codes per day or 2,000 coins for ten codes per day. Codes are 16 characters and each can be claimed by one viewer. Unclaimed codes expire after 24 hours or when the plan ends, whichever comes first. Daily limits reset at midnight in Nairobi. Visitors can select **Watch as guest** without creating an account if guest watching is enabled. Public LIVE discovery remains available to signed-in viewers.

For a 1v1 handoff, reserve the challenger’s seat using their Tiktok mwitu handle before sharing. The reservation lasts five minutes. The invited account can accept and enable its camera on arrival. Everyone else joins as a viewer.

## LIVE gifting and payment setup

Signed-in viewers can send virtual gifts to the host, an accepted guest, or a 1v1 challenger. New gifts reserve 15% for the platform and record 85% as performer earnings in the same transaction. The wallet and admin dashboard show the respective totals. Earnings are recorded in coins with two decimal places. Cash withdrawals are outside this flow.

## Promote

Creators can promote their own videos from the feed or **Account → Promote**, and boost an active broadcast from **Share LIVE → Boost LIVE**. The platform counts one visible placement per signed-in account or anonymous browser for each campaign, and shows action clicks in the campaign dashboard. Budgets are reserved from the wallet. Unspent coins return on expiry, stop, or when the last creative or broadcast becomes unavailable. Website actions open the creator’s supplied HTTPS destination.

- **M-Pesa.** Provision Daraja M-Pesa Express for the Mwitu merchant. In the private API environment set `MPESA_ENV=production`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY` and `PAYMENT_API_ORIGIN=https://api.tiktokmwitu.co.ke`. The API supplies the order-specific HTTPS callback to Daraja. The default `MPESA_TRANSACTION_TYPE` is `CustomerPayBillOnline`.
- **Card.** Set the Mwitu merchant's KES-enabled `PAYSTACK_SECRET_KEY` in the private API environment. In Paystack configure `https://api.tiktokmwitu.co.ke/api/gifts/webhooks/card` and set `PAYSTACK_WEBHOOK_SECRET` when using Paystack's dedicated signing secret. The API also accepts Paystack's legacy signature and verifies the payment with Paystack before adding coins.

After updating credentials, recreate the API service. On an HTTPS production deployment, sandbox credentials stay disabled by default. Use `GIFTS_ALLOW_TEST_PAYMENTS=true` only in an isolated HTTPS test deployment. Test each provider with the merchant's sandbox before enabling production credentials.
