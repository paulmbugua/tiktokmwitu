
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
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
import { allowedOrigins, connectRealtime, cookie, db, digest, identity, mediaDir, origin } from './infra';
import { AdminController } from './admin';
import { schema } from './schema';
import { SocialController } from './social';
import { LiveController, reconcileLive } from './live';
import { LiveModerationController } from './live-moderation';
import { liveSchema } from './live-store';
import { VideosController } from './videos';

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
  controllers: [AuthController, HealthController, SocialController, VideosController, LiveController, LiveModerationController, AdminController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class AppModule {}

async function start() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('Set DATABASE_URL or PGHOST before starting the API.');
  const publicMedia = join(mediaDir, 'public');
  await mkdir(publicMedia, { recursive: true });
  await db.query(schema + liveSchema);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
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
    const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mp4$/.exec(req.path);
    if (!match || !['GET', 'HEAD'].includes(req.method)) { res.sendStatus(404); return; }
    try {
      const video = await db.query('SELECT 1 FROM videos WHERE id=$1', [match[1]]);
      if (!video.rowCount) { res.sendStatus(404); return; }
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
  }, 3600000);
  expiry.unref();
  const liveSweep = setInterval(() => void reconcileLive(), 4000);
  liveSweep.unref();
  await app.listen(Number(process.env.API_PORT ?? 4000), process.env.API_HOST ?? '127.0.0.1');
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
