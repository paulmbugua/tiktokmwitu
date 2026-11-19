import { Body, ConflictException, Controller, ForbiddenException, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { parse, requireUser, uuid } from './infra';
import { liveService, notifyRoom, roomName } from './live';
import { currentMatch, lockedRoom, member, requireOpen, settle } from './live-store';
import { coinBalance, giftCatalog } from './gift-store';

const giftInput = z.object({ requestId: z.uuid(), recipientId: z.uuid(), gift: z.enum(['spark', 'matatu', 'chai', 'drums', 'crown', 'comet']) });

@Controller('live/:id/gifts')
export class LiveGiftsController {
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async send(@Req() req: Request, @Param('id') raw: string, @Body() body: unknown) {
    const sender = await requireUser(req);
    const id = uuid(raw);
    const input = parse(giftInput, body);
    const gift = giftCatalog.find(gift => gift.id === input.gift)!;
    const receipt = await lockedRoom(id, async (client, room) => {
      // The wallet lock serializes spending by this user across all rooms.
      await client.query('INSERT INTO gift_wallets(user_id,balance) VALUES ($1,0) ON CONFLICT DO NOTHING', [sender.id]);
      const { rows: [wallet] } = await client.query<{ balance: number }>('SELECT balance FROM gift_wallets WHERE user_id=$1 FOR UPDATE', [sender.id]);
      const { rows: [prior] } = await client.query<{ id: string; room_id: string; gift_id: string; recipient_id: string }>(
        'SELECT id::text,room_id,gift_id,recipient_id FROM live_gifts WHERE sender_id=$1 AND request_id=$2', [sender.id, input.requestId]);
      if (prior) {
        if (prior.room_id !== id || prior.gift_id !== gift.id || prior.recipient_id !== input.recipientId) {
          throw new ConflictException('Start a new gift for this selection.');
        }
        return { id: prior.id, balance: await coinBalance(sender.id, client) };
      }
      requireOpen(room);
      await member(client, room, sender);
      if (input.recipientId === sender.id) throw new ForbiddenException('Choose someone else on stage.');
      await settle(client, room);
      const match = await currentMatch(client, room);
      const active = (await client.query<{ user_id: string }>(
        'SELECT user_id FROM live_stage_seats WHERE room_id=$1 AND accepted_at IS NOT NULL', [id])).rows.map(row => row.user_id);
      if (match && ['ready', 'running'].includes(match.status)) active.push(match.guest_id);
      active.push(room.host_id);
      if (active.includes(sender.id)) throw new ForbiddenException('Send gifts while watching from the audience.');
      if (!active.includes(input.recipientId)) throw new ConflictException('That person has left the stage.');
      if (wallet.balance < gift.coins) throw new ConflictException('You need more coins for this gift.');
      const participants = await liveService().listParticipants(roomName(id));
      if (!participants.some(person => person.identity === sender.id)) throw new ForbiddenException('Join this LIVE to send gifts.');
      if (!participants.some(person => person.identity === input.recipientId)) throw new ConflictException('That person is reconnecting.');
      const { rows: [updated] } = await client.query<{ balance: number }>(
        'UPDATE gift_wallets SET balance=balance-$2 WHERE user_id=$1 RETURNING balance', [sender.id, gift.coins]);
      const { rows: [sent] } = await client.query<{ id: string }>(`
        INSERT INTO live_gifts(request_id,room_id,sender_id,recipient_id,gift_id,coins,platform_minor)
        VALUES ($1,$2,$3,$4,$5,$6,$6*15) RETURNING id::text`, [input.requestId, id, sender.id, input.recipientId, gift.id, gift.coins]);
      return { id: sent.id, balance: updated.balance };
    });
    notifyRoom(id);
    return receipt;
  }
}
