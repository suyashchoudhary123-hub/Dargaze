import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import {
  ChatSchema, CreateRoomSchema, EmoteSchema, HostActionSchema, InteractSchema, JoinRoomSchema,
  PingSchema, PlayerInputSchema, ReadySchema, ReportSchema, sanitizePlayerName,
} from '@dargaze/shared';
import { config, isAllowedOrigin } from './config.js';
import { pool } from './db.js';
import { verifyAccessToken, type AuthClaims } from './auth.js';
import { consumeRateLimit } from './rate-limit.js';
import { roomManager } from './room-manager.js';

interface SocketIdentity extends AuthClaims { sub: string; name: string; }
type GameSocket = Socket & { data: { identity: SocketIdentity } };
type Ack = (result: { ok: boolean; error?: string; [key: string]: unknown }) => void;
const EmptySchema = z.object({}).strict();
const maxBadMessages = 5;
const profanity = /\b(fuck|shit|bitch|asshole|cunt|bastard)\b/gi;

function ackOf(value: unknown): Ack | undefined { return typeof value === 'function' ? value as Ack : undefined; }
function safeChat(value: string): string {
  return value.replace(/[<>\u0000-\u001f]/g, '').replace(profanity, '••••').trim().slice(0, 240);
}

export function attachSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)), credentials: true, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 16_384,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    transports: ['websocket', 'polling'],
  });

  io.engine.use((request: IncomingMessage, _response: ServerResponse, next: (error?: Error) => void) => {
    if (config.nodeEnv === 'production') {
      const forwardedProto = request.headers['x-forwarded-proto'];
      const directlyEncrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
      if (!directlyEncrypted && forwardedProto !== 'https') return next(new Error('WSS required'));
    }
    next();
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > 4096) { next(new Error('Authentication required')); return; }
    try {
      const claims = verifyAccessToken(token);
      socket.data.identity = claims as SocketIdentity;
      next();
    } catch { next(new Error('Invalid or expired access token')); }
  });

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as GameSocket;
    let badMessages = 0;
    const identity = socket.data.identity;
    const reject = (ack: Ack | undefined, message: string, malformed = false) => {
      if (malformed) {
        badMessages += 1;
        console.warn(`[socket] malformed event from ${identity.sub} (${socket.id})`);
      }
      ack?.({ ok: false, error: message });
      if (badMessages >= maxBadMessages) socket.disconnect(true);
    };
    const handle = <T>(event: string, schema: z.ZodType<T>, fn: (data: T, ack?: Ack) => Promise<void> | void) => {
      socket.on(event, async (...args: unknown[]) => {
        const ack = ackOf(args[1]);
        const parsed = schema.safeParse(args[0] ?? {});
        if (!parsed.success) { reject(ack, 'Invalid message', true); return; }
        try { await fn(parsed.data, ack); }
        catch (error) {
          const message = error instanceof Error ? error.message : 'Request failed';
          reject(ack, message);
        }
      });
    };

    handle('room:create', CreateRoomSchema, async (data, ack) => {
      const ipKey = socket.handshake.address;
      if (!await consumeRateLimit(`room-create:user:${identity.sub}`, 3, 3600) || !await consumeRateLimit(`room-create:ip:${ipKey}`, 10, 3600)) { reject(ack, 'Room creation limit reached'); return; }
      const created = await roomManager.create({ id: identity.sub, name: data.playerName, ...(identity.email ? { email: identity.email } : {}), guest: identity.guest }, socket.id);
      await socket.join(created.room.code);
      ack?.({ ok: true, room: created.room, inviteToken: created.inviteToken });
      socket.emit('room:invite', { token: created.inviteToken, expiresAt: created.room.inviteExpiresAt });
      io.to(created.room.code).emit('room:update', created.room);
    });

    handle('room:join', JoinRoomSchema, async (data, ack) => {
      if (!await consumeRateLimit(`room-join:user:${identity.sub}`, 12, 60) || !await consumeRateLimit(`room-join:ip:${socket.handshake.address}`, 40, 60)) { reject(ack, 'Join limit reached. Try again shortly.'); return; }
      const room = await roomManager.join({ id: identity.sub, name: data.playerName, ...(identity.email ? { email: identity.email } : {}), guest: identity.guest }, socket.id, { ...(data.code ? { code: data.code } : {}), ...(data.inviteToken ? { inviteToken: data.inviteToken } : {}) });
      await socket.join(room.code);
      ack?.({ ok: true, room });
      io.to(room.code).emit('room:update', room);
    });

    handle('room:ready', ReadySchema, (data, ack) => {
      const room = roomManager.setReady(identity.sub, data.ready);
      ack?.({ ok: true, room }); io.to(room.code).emit('room:update', room);
    });

    handle('room:start', EmptySchema, (data, ack) => {
      void data;
      const room = roomManager.start(identity.sub);
      ack?.({ ok: true, room }); io.to(room.code).emit('room:update', room); io.to(room.code).emit('game:started', room);
    });

    handle('room:host', HostActionSchema, (data, ack) => {
      if (data.action === 'start') {
        const room = roomManager.start(identity.sub); ack?.({ ok: true, room }); io.to(room.code).emit('room:update', room); io.to(room.code).emit('game:started', room); return;
      }
      const result = roomManager.hostAction(identity.sub, data.action, {
        ...('isPrivate' in data ? { isPrivate: data.isPrivate } : {}),
        ...('playerId' in data ? { playerId: data.playerId } : {}),
      });
      if (result.kickedSocket) {
        const target = io.sockets.sockets.get(result.kickedSocket);
        target?.emit('room:kicked', { reason: 'The host removed you from this room.' });
        target?.leave(result.room.code); target?.disconnect(true);
      }
      ack?.({ ok: true, room: result.room, ...(result.inviteToken ? { inviteToken: result.inviteToken } : {}) });
      io.to(result.room.code).emit('room:update', result.room);
    });

    handle('room:leave', EmptySchema, async (_data, ack) => {
      const result = roomManager.leave(identity.sub, socket.id);
      if (result.roomCode) await socket.leave(result.roomCode);
      if (result.room) io.to(result.room.code).emit('room:update', result.room);
      ack?.({ ok: true });
    });

    handle('player:input', PlayerInputSchema, async (data, ack) => {
      if (!await consumeRateLimit(`input:socket:${socket.id}`, 45, 1) || !await consumeRateLimit(`input:user:${identity.sub}`, 50, 1)) { reject(ack, 'Input rate exceeded'); return; }
      if (!roomManager.updateInput(identity.sub, socket.id, { ...data, jump: data.jump ?? false })) { ack?.({ ok: false, error: 'Stale or unavailable input' }); return; }
      ack?.({ ok: true, seq: data.seq });
    });

    handle('game:interact', InteractSchema, async (data, ack) => {
      if (!await consumeRateLimit(`interact:${socket.id}`, 4, 2)) { reject(ack, 'Slow down'); return; }
      const result = roomManager.interact(identity.sub, data.targetId);
      ack?.({ ok: true, message: result.message, room: result.room, completed: result.completed ?? false });
      io.to(result.room.code).emit('room:update', result.room);
      io.to(result.room.code).emit('game:event', { type: result.completed ? 'level-complete' : 'interaction', message: result.message });
      if (result.completed && pool) {
        for (const player of result.room.players) {
          if (player.kind !== 'human' || player.id.startsWith('guest-')) continue;
          void pool.query(
            "INSERT INTO player_progress (user_id, highest_level, completed_levels, shared_inventory) VALUES ($1, 'level-2', ARRAY['ember-cliffs'], '{\"embers\":3}'::JSONB) ON CONFLICT (user_id) DO UPDATE SET highest_level = 'level-2', completed_levels = (SELECT ARRAY(SELECT DISTINCT unnest(player_progress.completed_levels || ARRAY['ember-cliffs']))), shared_inventory = '{\"embers\":3}'::JSONB, updated_at = NOW()",
            [player.id],
          ).catch(() => console.error('[progress] save failed'));
        }
      }
    });

    handle('room:chat', ChatSchema, async (data, ack) => {
      if (!await consumeRateLimit(`chat:${identity.sub}`, 8, 10)) { reject(ack, 'Chat is temporarily rate limited'); return; }
      const code = roomManager.roomCodeFor(identity.sub);
      if (!code) { reject(ack, 'Join a room to chat'); return; }
      const text = safeChat(data.text);
      if (!text) { reject(ack, 'Message is empty'); return; }
      io.to(code).emit('room:chat', { id: identity.sub, name: sanitizePlayerName(identity.name), text, at: Date.now() });
      ack?.({ ok: true });
    });

    handle('room:emote', EmoteSchema, async (data, ack) => {
      if (!await consumeRateLimit(`emote:${socket.id}`, 3, 2)) { reject(ack, 'Emote rate exceeded'); return; }
      const code = roomManager.roomCodeFor(identity.sub); if (!code) { reject(ack, 'Join a room first'); return; }
      io.to(code).emit('room:emote', { id: identity.sub, emote: data.emote, at: Date.now() }); ack?.({ ok: true });
    });

    handle('room:ping', PingSchema, async (data, ack) => {
      if (!await consumeRateLimit(`ping:${socket.id}`, 4, 5)) { reject(ack, 'Ping rate exceeded'); return; }
      const code = roomManager.roomCodeFor(identity.sub); if (!code) { reject(ack, 'Join a room first'); return; }
      io.to(code).emit('room:ping', { id: identity.sub, x: data.x, z: data.z, kind: data.kind, at: Date.now() }); ack?.({ ok: true });
    });

    handle('room:report', ReportSchema, async (data, ack) => {
      if (!await consumeRateLimit(`report:${identity.sub}`, 3, 3600)) { reject(ack, 'Report limit reached'); return; }
      const code = roomManager.roomCodeFor(identity.sub); const room = code ? roomManager.getRoom(code) : undefined;
      if (!room || !room.players.some((player) => player.id === data.playerId) || data.playerId === identity.sub) { reject(ack, 'That player is not in your party'); return; }
      // Report metadata only; chat contents, email and tokens are never included in logs.
      console.warn(`[moderation] report submitted room=${code} reporter=${identity.sub} target=${data.playerId} reason=${data.reason}`);
      ack?.({ ok: true });
    });

    handle('room:list', EmptySchema, async (_data, ack) => {
      if (!await consumeRateLimit(`public-list:${socket.handshake.address}`, 20, 60)) { reject(ack, 'Room search limit reached'); return; }
      ack?.({ ok: true, rooms: roomManager.listPublicRooms() });
    });
    handle('net:ping', EmptySchema, (_data, ack) => { ack?.({ ok: true, serverTime: Date.now() }); });

    socket.on('disconnect', () => {
      const disconnected = roomManager.disconnect(identity.sub, socket.id);
      if (disconnected.room) {
        io.to(disconnected.room.code).emit('room:update', disconnected.room);
        if (disconnected.newHost) io.to(disconnected.room.code).emit('room:notice', { message: 'Host controls transferred to a party member.' });
      }
    });
  });

  let previous = Date.now();
  const timer = setInterval(() => {
    const now = Date.now(); const delta = (now - previous) / 1000; previous = now;
    for (const room of roomManager.tick(delta, now)) io.to(room.code).emit('world:snapshot', room);
  }, 1000 / 20);
  timer.unref();
  return io;
}
