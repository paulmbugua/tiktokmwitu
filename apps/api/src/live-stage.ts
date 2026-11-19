import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { handleSchema, parse, requireUser, uuid, type Person } from './infra';
import { connectedUser, liveService, notifyRoom, publishPermission, roomName } from './live';
import { currentMatch, dropStageSeat, lockedRoom, member, requireOpen, settle, stageCapacity } from './live-store';

const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('invite'), handle: handleSchema }),
  z.object({ action: z.enum(['accept', 'decline', 'restore', 'leave', 'remove']), seatId: z.uuid() }),
  z.object({ action: z.literal('spotlight'), userId: z.uuid().nullable() }),
  z.object({ action: z.literal('fullscreen'), userId: z.uuid(), enabled: z.boolean() }),
]);

@Controller('live/:id/stage')
export class LiveStageController {
  @Get('audience')
  async audience(@Req() req: Request, @Param('id') raw: string) {
    const host = await requireUser(req);
    return lockedRoom(uuid(raw), async (client, room) => {
      requireOpen(room);
      if (room.host_id !== host.id) throw new ForbiddenException('Only the host can open the audience list.');
      const connected = (await liveService().listParticipants(roomName(room.id))).map(person => person.identity);
      const { rows } = await client.query<Person>(`
        SELECT u.id,u.handle,u.display_name FROM live_members m JOIN users u ON u.id=m.user_id
        WHERE m.room_id=$1 AND NOT m.banned AND u.id<>$2 AND u.id::text=ANY($3::text[])
          AND NOT EXISTS (SELECT 1 FROM live_stage_seats s WHERE s.room_id=$1 AND s.user_id=u.id
            AND (s.accepted_at IS NOT NULL OR s.expires_at>clock_timestamp()))
        ORDER BY lower(u.display_name),u.handle LIMIT 150`, [room.id, host.id, connected]);
      return rows;
    });
  }

  @Post()
  @Throttle({ default: { limit: 45, ttl: 60000 } })
  async command(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const actor = await requireUser(req);
    const id = uuid(raw);
    const command = parse(commandSchema, body);
    const name = roomName(id);
    await lockedRoom(id, async (client, room) => {
      requireOpen(room);
      await member(client, room, actor);
      const host = room.host_id === actor.id;
      if (['invite', 'remove', 'spotlight', 'fullscreen'].includes(command.action) && !host) {
        throw new ForbiddenException('Only the host can manage the stage.');
      }
      let targetId: string | null;
      if (command.action === 'invite') {
        await settle(client, room);
        if (await currentMatch(client, room)) throw new ConflictException('Finish the 1v1 before inviting stage guests.');
        await client.query('DELETE FROM live_stage_seats WHERE room_id=$1 AND accepted_at IS NULL AND expires_at<=clock_timestamp()', [id]);
        const { rows: [guest] } = await client.query<Person>('SELECT id,handle,display_name FROM users WHERE handle=$1', [command.handle]);
        if (!guest || guest.id === actor.id) throw new NotFoundException('Choose another Tiktok mwitu account.');
        await member(client, room, guest);
        const seats = await client.query<{ user_id: string }>('SELECT user_id FROM live_stage_seats WHERE room_id=$1', [id]);
        if (seats.rows.some(seat => seat.user_id === guest.id)) return;
        if (seats.rows.length >= stageCapacity) throw new ConflictException('All seven guest seats are reserved.');
        await client.query('INSERT INTO live_stage_seats(room_id,user_id) VALUES ($1,$2)', [id, guest.id]);
        targetId = guest.id;
      } else if (command.action === 'spotlight') {
        targetId = command.userId;
        if (targetId && targetId !== room.host_id && !(await client.query(
          'SELECT 1 FROM live_stage_seats WHERE room_id=$1 AND user_id=$2 AND accepted_at IS NOT NULL', [id, targetId])).rowCount) {
          throw new ConflictException('That guest is no longer on stage.');
        }
        await client.query('UPDATE live_rooms SET spotlight_id=$2,spotlight_fullscreen=false WHERE id=$1', [id, targetId]);
      } else if (command.action === 'fullscreen') {
        targetId = command.userId;
        if (room.spotlight_id !== targetId) throw new ConflictException('The spotlight changed. Select it again.');
        await client.query('UPDATE live_rooms SET spotlight_fullscreen=$2 WHERE id=$1', [id, command.enabled]);
      } else {
        const { rows: [seat] } = await client.query<{ user_id: string; accepted_at: Date | null; expires_at: Date }>(
          'SELECT user_id,accepted_at,expires_at FROM live_stage_seats WHERE room_id=$1 AND id=$2', [id, command.seatId]);
        if (!seat) {
          if (['remove', 'leave', 'decline'].includes(command.action)) return;
          throw new ConflictException('This stage invitation is no longer available.');
        }
        targetId = seat.user_id;
        if (command.action !== 'remove' && targetId !== actor.id) throw new ForbiddenException();
        if (command.action === 'accept' || command.action === 'restore') {
          if (!seat.accepted_at && (command.action === 'restore' || seat.expires_at <= new Date())) {
            throw new ConflictException('This stage invitation has expired.');
          }
          await connectedUser(id, actor.id);
          await liveService().updateParticipant(name, actor.id, { permission: publishPermission(true) });
          await client.query(`
            UPDATE live_stage_seats SET accepted_at=COALESCE(accepted_at,clock_timestamp()),missing_since=NULL
            WHERE room_id=$1 AND id=$2`, [id, command.seatId]);
          if (command.action === 'restore' || seat.accepted_at) return;
        } else {
          if (command.action === 'decline' && seat.accepted_at) throw new ConflictException('Use Leave stage to step down.');
          await dropStageSeat(client, id, targetId);
          if (seat.accepted_at) {
            await liveService().updateParticipant(name, targetId, { permission: publishPermission(false) })
              .catch(() => undefined); // The room sweep retries revocation if the participant moved or LiveKit timed out.
          }
        }
      }
      await client.query('INSERT INTO live_audit(room_id,actor_id,target_id,action,details) VALUES ($1,$2,$3,$4,$5)',
        [id, actor.id, targetId, 'stage:' + command.action, JSON.stringify(command)]);
    });
    notifyRoom(id);
    return { ok: true };
  }
}
