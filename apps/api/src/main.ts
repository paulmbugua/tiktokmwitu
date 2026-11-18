
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { AuthController } from './auth';
import { connectRealtime, cookie, db, digest, identity, mediaDir, origin } from './infra';
import { schema } from './schema';
import { SocialController } from './social';
import { LiveController } from './live';
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
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }])],
  controllers: [AuthController, HealthController, SocialController, VideosController, LiveController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class AppModule {}

async function start() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('Set DATABASE_URL or PGHOST before starting the API.');
  const publicMedia = join(mediaDir, 'public');
  await mkdir(publicMedia, { recursive: true });
  await db.query(schema);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.use(helmet());
  app.use(cookieParser());
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && (req.get('x-mwitu-request') !== '1' || (req.get('origin') && req.get('origin') !== origin))) {
      res.status(403).json({ message: 'Request origin is invalid.' });
      return;
    }
    next();
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
  await app.listen(Number(process.env.API_PORT ?? 4000), process.env.API_HOST ?? '127.0.0.1');
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
