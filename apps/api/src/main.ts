
import 'reflect-metadata';
import { Controller, Get, Module, NotFoundException } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { AuthController } from './auth';
import { googleSchema } from './google-auth';
import { allowedOrigins, connectRealtime, cookie, db, digest, identity, mediaDir, origin } from './infra';
import { AdminController } from './admin';
import { schema } from './schema';
import { SocialController } from './social';
import { ProfileImagesController, readProfileImage } from './profile-images';
import { LiveController, pushGuestBroadcasts, reconcileLive } from './live';
import { LiveStageController } from './live-stage';
import { LiveModerationController } from './live-moderation';
import { playbackUrl, sweepCloudMedia, type MediaStorage } from './media-storage';
import { getVideoThumbnail } from './media';
import { liveSchema } from './live-store';
import { VideosController } from './videos';
import { giftSchema } from './gift-store';
import { GiftPaymentsController, reconcileTopups } from './gift-payments';
import { LiveGiftsController } from './live-gifts';
import { inviteSchema, LiveInvitesController, sweepInviteCodes } from './live-invites';
import { PromoteController, promotionSchema, settlePromotions } from './promote';
import { reconcileStreams, streamSchema } from './live-stream';
import { livePricingSchema } from './live-pricing';

@Controller()
class HealthController {
  @Get('health')
  async health() {
    await db.query('SELECT 1');
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot({
    throttlers: [{ ttl: 60000, limit: 300 }],
    getTracker: request => {
      const req = request as Request;
      const clientIp = req.get('cf-connecting-ip');
      if (process.env.TRUST_CLOUDFLARE_TUNNEL === 'true' && clientIp && isIP(clientIp)) return clientIp;
      return req.ip ?? req.socket.remoteAddress ?? 'unknown';
    },
  })],
  controllers: [AuthController, HealthController, SocialController, VideosController, LiveController, LiveStageController, LiveModerationController,
    AdminController, GiftPaymentsController, LiveGiftsController, LiveInvitesController, PromoteController, ProfileImagesController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class AppModule {}

async function start() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('Set DATABASE_URL or PGHOST before starting the API.');
  const publicMedia = join(mediaDir, 'public');
  await mkdir(publicMedia, { recursive: true });
  await db.query(schema + googleSchema + liveSchema + giftSchema + inviteSchema + promotionSchema + streamSchema + livePricingSchema);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.use(helmet());
  app.enableCors({
    origin: (requestOrigin, done) => done(null, !!requestOrigin && allowedOrigins.includes(requestOrigin)),
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Mwitu-Request'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });
  app.use(cookieParser());
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (req.method === 'POST' && /^\/gifts\/webhooks\/(card|mpesa\/[a-f0-9-]{36}\/[a-f0-9]{64})$/.test(req.path)) {
      next();
      return;
    }
    const requestOrigin = req.get('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && (req.get('x-mwitu-request') !== '1' || (requestOrigin && !allowedOrigins.includes(requestOrigin)))) {
      res.status(403).json({ message: 'Request origin is invalid.' });
      return;
    }
    next();
  });
  app.use('/media', async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Cache-Control', 'private, no-cache');
    const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(mp4|jpg)$/.exec(req.path);
    if (!match || !['GET', 'HEAD'].includes(req.method)) { res.sendStatus(404); return; }
    try {
      const [ , id, extension] = match;
      const video = await db.query<{ media_storage: MediaStorage }>('SELECT media_storage FROM videos WHERE id=$1', [id]);
      if (!video.rowCount && extension === 'jpg') {
        const { rows: [photo] } = await db.query<{ id: string; storage: MediaStorage }>(`
          SELECT id,storage FROM profile_images WHERE id=$1 UNION ALL SELECT id,storage FROM post_photos WHERE id=$1`, [id]);
        if (!photo) { res.sendStatus(404); return; }
        if (req.query.download === '1') res.attachment('mwitu-' + id + '.jpg');
        res.type('jpg').send(await readProfileImage(photo));
        return;
      }
      if (!video.rowCount) { res.sendStatus(404); return; }
      if (extension === 'jpg') {
        try {
          const thumbnail = await getVideoThumbnail(id, video.rows[0].media_storage);
          res.type('jpg').send(thumbnail);
        } catch (error) {
          if (error instanceof NotFoundException) res.sendStatus(404);
          else res.set('Retry-After', '15').sendStatus(503);
        }
        return;
      }
      const download = req.query.download === '1';
      if (video.rows[0].media_storage === 'r2') {
        res.setHeader('Cache-Control', 'private, no-store');
        res.redirect(307, playbackUrl(id, download));
        return;
      }
      if (download) res.setHeader('Content-Disposition', 'attachment; filename="mwitu-' + match[1] + '.mp4"');
      next();
    } catch (error) { next(error); }
  });
  app.useStaticAssets(publicMedia, { prefix: '/media', dotfiles: 'deny', index: false });
  app.setGlobalPrefix('api');

  const io = new Server(app.getHttpServer(), {
    cors: { origin, credentials: true },
    transports: ['websocket'],
    allowRequest: (req, next) => next(null, !req.headers.origin || req.headers.origin === origin),
    maxHttpBufferSize: 4096,
  });
  connectRealtime(io);
  io.use(async (socket, next) => {
    try {
      const token = (socket.request.headers.cookie ?? '').split(/;\s*/)
        .find(part => part.startsWith(cookie + '='))?.slice(cookie.length + 1);
      const user = await identity(token);
      if (user && token) {
        const session = digest(token);
        const { rows: [row] } = await db.query('SELECT expires_at FROM sessions WHERE digest=$1', [session]);
        if (row) {
          socket.data.user = user.id;
          socket.data.session = session;
          socket.data.expiresAt = new Date(row.expires_at).getTime();
        }
      }
      next();
    } catch {
      next(new Error('Connection unavailable.'));
    }
  });
  io.on('connection', socket => {
    if (!socket.data.user) return;
    socket.join(['person:' + socket.data.user, 'session:' + socket.data.session]);
    const expire = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
    socket.once('disconnect', () => clearTimeout(expire));
  });

  const expiry = setInterval(() => {
    void db.query('DELETE FROM sessions WHERE expires_at <= now()').catch(error => console.error('Session cleanup failed', error));
    void db.query('DELETE FROM google_signup WHERE expires_at <= now()').catch(error => console.error('Google signup cleanup failed', error));
  }, 3600000);
  expiry.unref();
  const liveSweep = setInterval(() => void reconcileLive(), 4000);
  liveSweep.unref();
  const streamSweep = setInterval(() => void reconcileStreams(), 2500);
  streamSweep.unref();
  const audiencePush = setInterval(() => void pushGuestBroadcasts(), 1500);
  audiencePush.unref();
  const paymentSweep = setInterval(() => void reconcileTopups(), 4000);
  paymentSweep.unref();
  const inviteSweep=setInterval(()=>void sweepInviteCodes().catch(error=>console.error('LIVE invite cleanup failed',error)),3600000);
  inviteSweep.unref();
  const promotionSweep = setInterval(() => void settlePromotions(), 12000);
  promotionSweep.unref();
  const mediaSweep = setInterval(() => void sweepCloudMedia().catch(error => console.error('Media cleanup failed', error)), 60000);
  mediaSweep.unref();
  await app.listen(Number(process.env.API_PORT ?? 4000), process.env.API_HOST ?? '127.0.0.1');
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
