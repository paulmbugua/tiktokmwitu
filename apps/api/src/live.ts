
import { Body, Controller, Get, NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AccessToken, DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cleanText, db, parse, requireUser, uuid } from './infra';

const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
const service = url && key && secret ? new RoomServiceClient(url, key, secret, { requestTimeout: 6 }) : null;
const prefix = 'mwitu-';
const chatTopic = 'mwitu-chat';
const roomId = (id: string) => prefix + id;
const knownName = /^mwitu-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

function liveService() {
  if (!service) throw new ServiceUnavailableException('Live broadcasts are unavailable.');
  return service;
}

async function activeRoom(id: string) {
  const [room] = await liveService().listRooms([roomId(id)]);
  if (!room?.numPublishers) throw new NotFoundException('This broadcast has ended.');
  return room.name;
}

async function grant(room: string, user: { id: string; display_name: string }, host: boolean) {
  const token = new AccessToken(key, secret, {
    identity: host ? user.id : user.id + ':' + randomUUID(),
    name: user.display_name,
    ttl: '5m',
  });
  token.addGrant({
    roomJoin: true, room, canPublish: host, canSubscribe: !host, canPublishData: false,
  });
  return { url, token: await token.toJwt(), host, id: room.slice(prefix.length) };
}

@Controller('live')
export class LiveController {
  @Get()
  @Throttle({ default: { ttl: 60000, limit: 75 } })
  async list() {
    if (!service) return { enabled: false, rooms: [] };
    const rooms = (await service.listRooms()).filter(room => room.numPublishers && knownName.test(room.name));
    const { rows } = await db.query(
      'SELECT id,handle,display_name FROM users WHERE id=ANY($1::uuid[]) ORDER BY handle',
      [rooms.map(room => room.name.slice(prefix.length))]);
    const viewers = new Map(rooms.map(room => [room.name, Math.max(0, room.numParticipants - 1)]));
    return { enabled: true, rooms: rows.map(user => ({ ...user, viewers: viewers.get(roomId(user.id)) ?? 0 })) };
  }

  @Post('start')
  @Throttle({ default: { ttl: 60000, limit: 8 } })
  async start(@Req() req: Request) {
    const user = await requireUser(req);
    liveService();
    return grant(roomId(user.id), user, true);
  }

  @Post(':id/join')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  async join(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    return grant(await activeRoom(uuid(raw)), user, false);
  }

  @Post(':id/chat')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async chat(@Req() req: Request, @Param('id') raw: string, @Body() input: unknown) {
    const user = await requireUser(req);
    const { body } = parse(z.object({ body: cleanText(300) }), input);
    const name = await activeRoom(uuid(raw));
    const payload = encoder.encode(JSON.stringify({ id: randomUUID(), handle: user.handle, body }));
    await liveService().sendData(name, payload, DataPacket_Kind.RELIABLE, { topic: chatTopic });
    return { ok: true };
  }
}
