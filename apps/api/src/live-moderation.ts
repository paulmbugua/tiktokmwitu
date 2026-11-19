import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { cleanText, parse, requireUser, uuid } from './infra';
import { connectedUser, guestIdentityPrefix, liveService, notifyRoom, roomName } from './live';
import { currentMatch, dropStageSeat, endMatch, lockedRoom, member, requireOpen, settle } from './live-store';

const controls = z.discriminatedUnion('action', [
  z.object({ action: z.literal('chat'), open: z.boolean() }),
  z.object({ action: z.literal('guests'), open: z.boolean() }),
  z.object({ action: z.literal('keywords'), words: z.array(cleanText(50)).max(30) }),
  z.object({ action: z.enum(['pin', 'delete']), messageId: z.uuid() }),
  z.object({ action: z.literal('unpin') }),
  z.object({ action: z.enum(['appoint', 'revoke', 'unmute', 'ban', 'unban', 'dismissReports']), userId: z.uuid() }),
  z.object({ action: z.literal('mute'), userId: z.uuid(), minutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(60)]) }),
]);

function requireModerator(role: string) {
  if (role === 'viewer') throw new ForbiddenException('LIVE moderator access required.');
}

@Controller('live')
export class LiveModerationController {
  @Get(':id/moderation')
  async details(@Req() req: Request, @Param('id') raw: string) {
    const user = await requireUser(req);
    const id = uuid(raw);
    return lockedRoom(id, async (client, room) => {
      requireModerator((await member(client, room, user)).role);
      const identities = room.ended_at ? [] : (await liveService().listParticipants(roomName(id))).map(person => person.identity);
      const guests = identities.filter(id => id.startsWith(guestIdentityPrefix)).length;
      const accounts = identities.filter(id => !id.startsWith(guestIdentityPrefix));
      const { rows: people } = await client.query(`
        SELECT u.id,u.handle,u.display_name,COALESCE(m.moderator,false) AS moderator,
          m.muted_until,COALESCE(m.banned,false) AS banned,u.id=ANY($2::uuid[]) AS connected
        FROM users u LEFT JOIN live_members m ON m.user_id=u.id AND m.room_id=$1
        WHERE u.id=ANY($2::uuid[]) OR (m.user_id IS NOT NULL AND
          (m.moderator OR m.banned OR m.muted_until>now()))
        ORDER BY connected DESC,u.handle LIMIT 100`, [id, accounts]);
      const { rows: audit } = await client.query(`
        SELECT a.id,a.action,a.details,a.created_at,u.handle AS actor, t.handle AS target
        FROM live_audit a JOIN users u ON u.id=a.actor_id LEFT JOIN users t ON t.id=a.target_id
        WHERE a.room_id=$1 ORDER BY a.id DESC LIMIT 30`, [id]);
      const { rows: reports } = await client.query(`
        SELECT r.target_id,u.handle,r.reason,r.updated_at
        FROM live_reports r JOIN users u ON u.id=r.target_id
        WHERE r.room_id=$1 AND r.target_id<>$2 ORDER BY r.updated_at DESC LIMIT 50`, [id, room.host_id]);
      return { people, audit, reports, guests, keywords: room.keywords };
    });
  }

  @Post(':id/report')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async report(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const user = await requireUser(req);
    const id = uuid(raw);
    const { userId, reason } = parse(z.object({ userId: z.uuid(), reason: cleanText(300) }), body);
    if (user.id === userId) throw new BadRequestException('Choose another participant.');
    await connectedUser(id, user.id);
    await lockedRoom(id, async (client, room) => {
      requireOpen(room);
      await member(client, room, user);
      const target = await client.query('SELECT 1 FROM live_members WHERE room_id=$1 AND user_id=$2', [id, userId]);
      if (userId !== room.host_id && !target.rowCount) throw new NotFoundException('Participant unavailable.');
      await client.query(`
        INSERT INTO live_reports(room_id,reporter_id,target_id,reason) VALUES ($1,$2,$3,$4)
        ON CONFLICT(room_id,reporter_id,target_id) DO UPDATE SET reason=excluded.reason,updated_at=now()`,
        [id, user.id, userId, reason]);
    });
    notifyRoom(id);
    return { ok: true };
  }

  @Post(':id/moderation')
  @Throttle({ default: { ttl: 60000, limit: 40 } })
  async act(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const actor = await requireUser(req);
    const id = uuid(raw);
    const command = parse(controls, body);
    await lockedRoom(id, async (client, room) => {
      requireOpen(room);
      const { role } = await member(client, room, actor);
      requireModerator(role);
      const targetId = 'userId' in command ? command.userId : null;

      if (targetId) {
        if (command.action === 'dismissReports') {
          if (targetId === room.host_id) throw new ForbiddenException('Reports about hosts go to platform moderators.');
          await client.query('DELETE FROM live_reports WHERE room_id=$1 AND target_id=$2', [id, targetId]);
        } else {
          if (targetId === actor.id || targetId === room.host_id) throw new ForbiddenException('This participant is protected.');
          const { rows: [target] } = await client.query<{ moderator: boolean; banned: boolean }>(
            'SELECT moderator,banned FROM live_members WHERE room_id=$1 AND user_id=$2', [id, targetId]);
          if (!target) throw new NotFoundException('Participant has not joined this LIVE.');
          const delegation = command.action === 'appoint' || command.action === 'revoke';
          if (role !== 'host' && (delegation || target.moderator)) throw new ForbiddenException('Only the host can manage moderators.');
          if (command.action === 'appoint' && target.banned) throw new BadRequestException('Unban the participant first.');

          switch (command.action) {
            case 'appoint':
            case 'revoke':
              await client.query('UPDATE live_members SET moderator=$3 WHERE room_id=$1 AND user_id=$2', [id, targetId, command.action === 'appoint']);
              break;
            case 'mute':
              await client.query('UPDATE live_members SET muted_until=clock_timestamp()+make_interval(mins=>$3) WHERE room_id=$1 AND user_id=$2',
                [id, targetId, command.minutes]);
              break;
            case 'unmute':
              await client.query('UPDATE live_members SET muted_until=NULL WHERE room_id=$1 AND user_id=$2', [id, targetId]);
              break;
            case 'ban': {
              await client.query('UPDATE live_members SET banned=true,moderator=false WHERE room_id=$1 AND user_id=$2', [id, targetId]);
              await dropStageSeat(client, id, targetId);
              await settle(client, room);
              const match = await currentMatch(client, room);
              if (match?.guest_id === targetId) await endMatch(client, room, 'guest_removed', targetId);
              break;
            }
            case 'unban':
              await client.query('UPDATE live_members SET banned=false WHERE room_id=$1 AND user_id=$2', [id, targetId]);
              break;
          }
        }
      }

      if (command.action === 'chat') {
        await client.query('UPDATE live_rooms SET chat_open=$2 WHERE id=$1', [id, command.open]);
      } else if (command.action === 'guests') {
        if (role !== 'host') throw new ForbiddenException('Only the host can manage guest watching.');
        await client.query('UPDATE live_rooms SET guest_access=$2 WHERE id=$1', [id, command.open]);
      } else if (command.action === 'keywords') {
        const words = [...new Set(command.words.map(word => word.normalize('NFKC').toLowerCase()))];
        await client.query('UPDATE live_rooms SET keywords=$2 WHERE id=$1', [id, words]);
      } else if (command.action === 'unpin') {
        await client.query('UPDATE live_rooms SET pinned_id=NULL WHERE id=$1', [id]);
      } else if (command.action === 'pin' || command.action === 'delete') {
        const found = await client.query('SELECT 1 FROM live_messages WHERE room_id=$1 AND id=$2 AND deleted_at IS NULL', [id, command.messageId]);
        if (!found.rowCount) throw new NotFoundException('Message unavailable.');
        if (command.action === 'pin') {
          await client.query('UPDATE live_rooms SET pinned_id=$2 WHERE id=$1', [id, command.messageId]);
        } else {
          await client.query('UPDATE live_messages SET deleted_at=now() WHERE room_id=$1 AND id=$2', [id, command.messageId]);
          await client.query('UPDATE live_rooms SET pinned_id=NULL WHERE id=$1 AND pinned_id=$2', [id, command.messageId]);
        }
      }

      await client.query('INSERT INTO live_audit(room_id,actor_id,target_id,action,details) VALUES ($1,$2,$3,$4,$5)',
        [id, actor.id, targetId, command.action, JSON.stringify(command)]);
    });
    if (command.action === 'ban') {
      await lockedRoom(id, async (client) => {
        const { rows: [target] } = await client.query('SELECT banned FROM live_members WHERE room_id=$1 AND user_id=$2', [id, command.userId]);
        if (target?.banned) await liveService().removeParticipant(roomName(id), command.userId).catch(() => undefined);
      });
    }
    notifyRoom(id);
    return { ok: true };
  }
}
