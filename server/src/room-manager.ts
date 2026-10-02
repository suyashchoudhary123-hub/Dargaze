import { randomBytes } from 'node:crypto';
import {
  INVITE_TTL_SECONDS, LEVELS, PLAYER_SPEED, RECONNECT_GRACE_MS, ROOM_CAPACITY, WORLD_LIMITS,
  canReach, normalizeMovement, sanitizePlayerName,
  type AuthIdentity, type PlayerInput, type PlayerSnapshot, type RoomPhase, type RoomSnapshot,
} from '@dargaze/shared';
import { redis } from './db.js';

interface InternalPlayer extends PlayerSnapshot {
  ownerId: string | null;
  socketId: string | null;
  input: PlayerInput;
  lastInputSeq: number;
  velocityY: number;
  lastDamageAt: number;
  downedSince: number;
  disconnectDeadline: number | null;
}
interface InternalRoom {
  code: string;
  inviteToken: string;
  inviteExpiresAt: number;
  createdAt: number;
  hostId: string;
  phase: RoomPhase;
  isPrivate: boolean;
  players: [InternalPlayer, InternalPlayer, InternalPlayer];
  crystals: Set<string>;
  gateOpen: boolean;
  checkpoint: { x: number; z: number };
  lastPersistAt: number;
  banned: Set<string>;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AI_NAMES = ['Ivo', 'Tavi', 'Nico'];

function safeCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}
function aiPlayer(code: string, slot: number): InternalPlayer {
  return {
    id: `ai-${code}-${slot}`, ownerId: null, name: AI_NAMES[slot - 1] ?? `Friend ${slot}`,
    slot, kind: 'ai', connected: false, ready: true, x: (slot - 1) * 2, y: 0, z: LEVELS.emberCliffs.start.z,
    health: 100, downed: false, ping: 0, invulnerableUntil: 0,
    socketId: null, input: { seq: 0, moveX: 0, moveZ: 0, jump: false }, lastInputSeq: 0,
    velocityY: 0, lastDamageAt: 0, downedSince: 0, disconnectDeadline: null,
  };
}

export class RoomManager {
  private readonly rooms = new Map<string, InternalRoom>();
  private readonly playerRooms = new Map<string, string>();

  async create(identity: AuthIdentity, socketId: string): Promise<{ room: RoomSnapshot; inviteToken: string }> {
    if (this.playerRooms.has(identity.id)) throw new Error('You are already in an active room');
    let code = safeCode();
    while (this.rooms.has(code)) code = safeCode();
    const inviteToken = randomBytes(32).toString('hex');
    const now = Date.now();
    const host: InternalPlayer = {
      ...aiPlayer(code, 0), id: identity.id, ownerId: identity.id, name: sanitizePlayerName(identity.name),
      kind: 'human', connected: true, ready: true, socketId,
    };
    const room: InternalRoom = {
      code, inviteToken, inviteExpiresAt: now + INVITE_TTL_SECONDS * 1000, createdAt: now,
      hostId: identity.id, phase: 'lobby', isPrivate: true,
      players: [host, aiPlayer(code, 1), aiPlayer(code, 2)], crystals: new Set(), gateOpen: false,
      checkpoint: { ...LEVELS.emberCliffs.checkpoint }, lastPersistAt: 0, banned: new Set(),
    };
    this.rooms.set(code, room); this.playerRooms.set(identity.id, code);
    await this.persist(room);
    return { room: this.snapshot(room), inviteToken };
  }

  async join(identity: AuthIdentity, socketId: string, locator: { code?: string; inviteToken?: string }): Promise<RoomSnapshot> {
    let room: InternalRoom | undefined;
    if (locator.inviteToken) {
      room = [...this.rooms.values()].find((candidate) => candidate.inviteToken === locator.inviteToken && candidate.inviteExpiresAt > Date.now());
      if (!room && redis?.isReady) {
        const code = await redis.get(`dargaze:invite:${locator.inviteToken}`);
        const cached = code ? this.rooms.get(code) : undefined;
        if (cached?.inviteToken === locator.inviteToken && cached.inviteExpiresAt > Date.now()) room = cached;
      }
    } else if (locator.code) room = this.rooms.get(locator.code.toUpperCase());
    if (!room || (room.phase === 'complete')) throw new Error('That room is unavailable');
    if (room.banned.has(identity.id)) throw new Error('You cannot rejoin this room');

    const currentCode = this.playerRooms.get(identity.id);
    if (currentCode && currentCode !== room.code) throw new Error('You are already in another active match');
    const existing = room.players.find((player) => player.ownerId === identity.id);
    if (existing) {
      if (existing.disconnectDeadline && existing.disconnectDeadline > Date.now()) {
        existing.connected = true; existing.socketId = socketId; existing.disconnectDeadline = null;
        existing.name = sanitizePlayerName(identity.name); this.playerRooms.set(identity.id, room.code);
        await this.persist(room); return this.snapshot(room);
      }
      if (existing.connected && existing.socketId !== socketId) throw new Error('This account is already in the room');
    }
    const available = room.players.find((player) => player.kind === 'ai');
    if (!available) throw new Error('This room is full');
    const slot = available.slot;
    const previous = { x: available.x, y: available.y, z: available.z, health: available.health, invulnerableUntil: available.invulnerableUntil };
    Object.assign(available, {
      id: identity.id, ownerId: identity.id, name: sanitizePlayerName(identity.name), kind: 'human', connected: true,
      ready: false, socketId, disconnectDeadline: null, input: { seq: 0, moveX: 0, moveZ: 0, jump: false },
      lastInputSeq: 0, ...previous,
    });
    this.playerRooms.set(identity.id, room.code);
    await this.persist(room);
    return this.snapshot(room);
  }

  setReady(identityId: string, ready: boolean): RoomSnapshot {
    const { room, player } = this.locate(identityId);
    if (room.phase !== 'lobby') throw new Error('The match has already started');
    player.ready = ready; void this.persist(room); return this.snapshot(room);
  }

  start(identityId: string): RoomSnapshot {
    const { room } = this.locate(identityId);
    if (room.hostId !== identityId) throw new Error('Only the host can start the match');
    if (room.phase !== 'lobby') throw new Error('The match has already started');
    if (room.players.some((player) => player.kind === 'human' && player.connected && !player.ready)) throw new Error('Wait for every player to ready up');
    room.phase = 'playing';
    room.players.forEach((player, index) => {
      player.x = index === 0 ? 0 : index === 1 ? -2 : 2;
      player.y = 0; player.z = LEVELS.emberCliffs.start.z; player.health = 100; player.downed = false;
    });
    void this.persist(room); return this.snapshot(room);
  }

  updateInput(identityId: string, socketId: string, input: PlayerInput): boolean {
    const code = this.playerRooms.get(identityId); const room = code ? this.rooms.get(code) : undefined;
    const player = room?.players.find((item) => item.ownerId === identityId);
    if (!room || !player || !player.connected || player.socketId !== socketId || room.phase !== 'playing' || input.seq <= player.lastInputSeq) return false;
    player.input = input; player.lastInputSeq = input.seq;
    return true;
  }

  interact(identityId: string, targetId: string): { room: RoomSnapshot; message: string; completed?: boolean } {
    const { room, player } = this.locate(identityId);
    if (room.phase !== 'playing') throw new Error('Interactions are unavailable right now');
    if (player.downed) throw new Error('You are down. Ask a friend for help.');
    const level = LEVELS.emberCliffs;
    if (targetId === 'checkpoint') {
      if (!canReach(player, level.checkpointStone, 2.8)) throw new Error('Move closer to the checkpoint stone');
      room.checkpoint = { ...level.checkpointStone }; void this.persist(room);
      return { room: this.snapshot(room), message: 'Checkpoint attuned. Your party will return here.' };
    }
    const crystal = level.crystals.find((item) => item.id === targetId);
    if (crystal) {
      if (room.crystals.has(crystal.id)) throw new Error('That crystal has already been collected');
      if (!canReach(player, crystal, 2.6)) throw new Error('Move closer to the crystal');
      room.crystals.add(crystal.id); void this.persist(room);
      return { room: this.snapshot(room), message: `Ember Crystal found · ${room.crystals.size}/3` };
    }
    if (targetId === 'altar') {
      if (!canReach(player, level.altar, 3)) throw new Error('The altar is farther ahead');
      if (room.crystals.size < level.crystals.length) throw new Error('The altar needs all three Ember Crystals');
      room.gateOpen = true; void this.persist(room);
      return { room: this.snapshot(room), message: 'The altar awakens. The gate is open.' };
    }
    if (targetId === 'gate') {
      if (!canReach(player, level.gate, 4)) throw new Error('The gate is beyond the altar');
      if (!room.gateOpen) throw new Error('The gate is still sealed');
      room.phase = 'complete'; void this.persist(room);
      return { room: this.snapshot(room), message: 'Level 2 Unlocked', completed: true };
    }
    if (targetId.startsWith('revive:')) {
      const slotNumber = Number(targetId.slice('revive:'.length));
      const ally = room.players.find((item) => item.slot === slotNumber);
      if (!ally || !ally.downed || !canReach(player, ally, 2.4)) throw new Error('Move close to a downed friend');
      ally.downed = false; ally.health = 45; ally.downedSince = 0; ally.invulnerableUntil = Date.now() + 3000;
      return { room: this.snapshot(room), message: `${ally.name} is back on their feet.` };
    }
    throw new Error('Unknown interaction');
  }

  hostAction(identityId: string, action: 'privacy' | 'regenerateInvite' | 'kick', payload: { isPrivate?: boolean; playerId?: string } = {}): { room: RoomSnapshot; inviteToken?: string; kickedSocket?: string } {
    const { room } = this.locate(identityId);
    if (room.hostId !== identityId) throw new Error('Only the host can change room settings');
    if (action === 'privacy') room.isPrivate = payload.isPrivate ?? true;
    let inviteToken: string | undefined;
    let kickedSocket: string | undefined;
    if (action === 'regenerateInvite') {
      const oldToken = room.inviteToken;
      room.inviteToken = randomBytes(32).toString('hex'); room.inviteExpiresAt = Date.now() + INVITE_TTL_SECONDS * 1000; inviteToken = room.inviteToken;
      if (redis?.isReady) void redis.del(`dargaze:invite:${oldToken}`);
    }
    if (action === 'kick') {
      const player = room.players.find((item) => item.ownerId === payload.playerId);
      if (!player || player.ownerId === room.hostId) throw new Error('That player cannot be kicked');
      room.banned.add(player.ownerId!); kickedSocket = player.socketId ?? undefined;
      this.playerRooms.delete(player.ownerId!); Object.assign(player, aiPlayer(room.code, player.slot));
    }
    void this.persist(room);
    return { room: this.snapshot(room), ...(inviteToken ? { inviteToken } : {}), ...(kickedSocket ? { kickedSocket } : {}) };
  }

  disconnect(identityId: string, socketId: string): { room?: RoomSnapshot; roomCode?: string; newHost?: string } {
    const code = this.playerRooms.get(identityId); const room = code ? this.rooms.get(code) : undefined;
    if (!room) return {};
    const player = room.players.find((item) => item.ownerId === identityId && item.socketId === socketId);
    if (!player) return {};
    player.connected = false; player.socketId = null; player.disconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
    player.input = { seq: player.lastInputSeq, moveX: 0, moveZ: 0, jump: false };
    let newHost: string | undefined;
    if (room.hostId === identityId) {
      const successor = room.players.find((item) => item.connected && item.ownerId && item.ownerId !== identityId);
      if (successor?.ownerId) { room.hostId = successor.ownerId; newHost = successor.ownerId; }
    }
    void this.persist(room);
    return { room: this.snapshot(room), roomCode: room.code, ...(newHost ? { newHost } : {}) };
  }

  leave(identityId: string, socketId: string): { room?: RoomSnapshot; roomCode?: string } {
    const code = this.playerRooms.get(identityId); const room = code ? this.rooms.get(code) : undefined;
    if (!room) return {};
    const player = room.players.find((item) => item.ownerId === identityId && item.socketId === socketId);
    if (!player) return {};
    this.playerRooms.delete(identityId);
    const slot = player.slot;
    Object.assign(player, aiPlayer(room.code, slot));
    if (room.hostId === identityId) {
      const successor = room.players.find((item) => item.kind === 'human' && item.ownerId && item.ownerId !== identityId);
      if (successor?.ownerId) room.hostId = successor.ownerId;
    }
    const hasHuman = room.players.some((item) => item.kind === 'human' && item.ownerId);
    if (!hasHuman) {
      this.destroy(room);
      return { roomCode: room.code };
    }
    void this.persist(room); return { room: this.snapshot(room), roomCode: room.code };
  }

  getRoom(code: string): RoomSnapshot | undefined {
    const room = this.rooms.get(code.toUpperCase()); return room ? this.snapshot(room) : undefined;
  }

  listPublicRooms(): Array<{ code: string; players: number; phase: RoomPhase; createdAt: number }> {
    return [...this.rooms.values()].filter((room) => !room.isPrivate && room.phase === 'lobby' && room.players.some((player) => player.kind === 'ai'))
      .slice(0, 50).map((room) => ({ code: room.code, players: room.players.filter((player) => player.kind === 'human').length, phase: room.phase, createdAt: room.createdAt }));
  }

  roomCodeFor(identityId: string): string | undefined { return this.playerRooms.get(identityId); }

  tick(deltaSeconds: number, now = Date.now()): RoomSnapshot[] {
    const snapshots: RoomSnapshot[] = [];
    const dt = Math.max(0, Math.min(deltaSeconds, 0.08));
    for (const room of this.rooms.values()) {
      if (now - room.createdAt > 3 * 60 * 60 * 1000) { this.destroy(room); continue; }
      for (const player of room.players) {
        if (player.kind === 'human' && !player.connected && player.disconnectDeadline && player.disconnectDeadline <= now) {
          const expiredOwner = player.ownerId;
          if (expiredOwner) this.playerRooms.delete(expiredOwner);
          Object.assign(player, aiPlayer(room.code, player.slot));
          if (room.hostId === expiredOwner) {
            const successor = room.players.find((candidate) => candidate.kind === 'human' && candidate.ownerId);
            if (successor?.ownerId) room.hostId = successor.ownerId;
          }
        }
      }
      if (!room.players.some((player) => player.kind === 'human' && player.ownerId)) { this.destroy(room); continue; }
      if (room.phase !== 'playing') continue;
      const leader = room.players.find((player) => player.ownerId === room.hostId) ?? room.players[0];
      for (const player of room.players) {
        if (player.downed) {
          if (player.downedSince && now - player.downedSince > 18_000) {
            player.downed = false; player.health = 40; player.x = room.checkpoint.x; player.y = 0; player.z = room.checkpoint.z;
            player.velocityY = 0; player.invulnerableUntil = now + 3_000; player.downedSince = 0;
          } else continue;
        }
        let mx = player.input.moveX; let mz = player.input.moveZ; let jumping = player.input.jump;
        if (player.kind === 'ai' || !player.connected) {
          const fallen = room.players.filter((candidate) => candidate.downed && candidate !== player).sort((a, b) => Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z))[0];
          const side = player.slot === 1 ? -2.4 : 2.4;
          const targetX = fallen ? fallen.x : leader.x + side;
          const targetZ = fallen ? fallen.z : leader.z + 1.4;
          const dx = targetX - player.x; const dz = targetZ - player.z;
          const distance = Math.hypot(dx, dz);
          if (fallen && distance <= 2.15) {
            fallen.downed = false; fallen.health = 45; fallen.invulnerableUntil = now + 3_000; fallen.downedSince = 0;
            mx = 0; mz = 0;
          } else if (distance > 2.1) { const normalized = normalizeMovement(dx, dz); mx = normalized.x; mz = normalized.z; }
          else { mx = 0; mz = 0; }
          jumping = distance > 5 && player.y < 0.05;
        }
        const movement = normalizeMovement(mx, mz);
        player.x = Math.max(WORLD_LIMITS.minX, Math.min(WORLD_LIMITS.maxX, player.x + movement.x * PLAYER_SPEED * dt));
        player.z = Math.max(WORLD_LIMITS.minZ, Math.min(WORLD_LIMITS.maxZ, player.z + movement.z * PLAYER_SPEED * dt));
        if (jumping && player.y <= 0.001 && player.velocityY <= 0) player.velocityY = 6.6;
        player.velocityY -= 17 * dt;
        player.y += player.velocityY * dt;
        if (player.y < 0) { player.y = 0; player.velocityY = 0; }
        // Lava seams are intentionally narrow and telegraph their danger in the client world.
        const inLava = Math.abs(player.x - 12.5) < 1.25 && player.z > -24 && player.z < 7;
        if (inLava && player.y < 0.5 && now > player.invulnerableUntil && now - player.lastDamageAt > 500) {
          player.lastDamageAt = now; player.health = Math.max(0, player.health - 14);
          if (player.health === 0) { player.downed = true; player.downedSince = now; }
        }
        if (player.downed && player.ownerId === room.hostId && room.checkpoint) {
          // Host can recover by checkpoint after the party has time to revive them.
        }
      }
      if (!room.gateOpen && room.crystals.size === LEVELS.emberCliffs.crystals.length) {
        const humanAtAltar = room.players.some((player) => player.kind === 'human' && player.connected && canReach(player, LEVELS.emberCliffs.altar, 3.2));
        const aiAtAltar = room.players.some((player) => player.kind === 'ai' && canReach(player, LEVELS.emberCliffs.altar, 3.4));
        if (humanAtAltar && aiAtAltar) { room.gateOpen = true; void this.persist(room); }
      }
      snapshots.push(this.snapshot(room));
      if (now - room.lastPersistAt >= 2500) void this.persist(room);
    }
    return snapshots;
  }

  private locate(identityId: string): { room: InternalRoom; player: InternalPlayer } {
    const code = this.playerRooms.get(identityId); const room = code ? this.rooms.get(code) : undefined;
    const player = room?.players.find((item) => item.ownerId === identityId);
    if (!room || !player) throw new Error('You are not in a room');
    return { room, player };
  }

  private snapshot(room: InternalRoom): RoomSnapshot {
    return {
      code: room.code, hostId: room.hostId, phase: room.phase, isPrivate: room.isPrivate,
      inviteExpiresAt: room.inviteExpiresAt, createdAt: room.createdAt,
      players: room.players.map(({ id, name, slot, kind, connected, ready, x, y, z, health, downed, ping, invulnerableUntil }) => ({ id, name, slot, kind, connected, ready, x, y, z, health, downed, ping, invulnerableUntil })),
      crystals: [...room.crystals], gateOpen: room.gateOpen, checkpoint: { ...room.checkpoint },
    };
  }

  private async persist(room: InternalRoom): Promise<void> {
    room.lastPersistAt = Date.now();
    if (!redis?.isReady) return;
    try {
      await redis.set(`dargaze:room:${room.code}`, JSON.stringify(this.snapshot(room)), { EX: 3 * 60 * 60 });
      await redis.set(`dargaze:invite:${room.inviteToken}`, room.code, { EX: Math.max(1, Math.ceil((room.inviteExpiresAt - Date.now()) / 1000)) });
    } catch { console.error('[room] redis persistence failed'); }
  }

  private destroy(room: InternalRoom): void {
    for (const player of room.players) if (player.ownerId) this.playerRooms.delete(player.ownerId);
    this.rooms.delete(room.code);
    if (redis?.isReady) {
      void redis.del(`dargaze:room:${room.code}`);
      void redis.del(`dargaze:invite:${room.inviteToken}`);
    }
  }
}

export const roomManager = new RoomManager();
