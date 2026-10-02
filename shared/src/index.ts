import { z } from 'zod';

export const ROOM_CAPACITY = 3 as const;
export const SERVER_TICK_HZ = 20;
export const INVITE_TTL_SECONDS = 30 * 60;
export const RECONNECT_GRACE_MS = 5 * 60 * 1000;
export const PLAYER_SPEED = 5.2;
export const WORLD_LIMITS = { minX: -17, maxX: 17, minZ: -34, maxZ: 18 } as const;

export const PlayerNameSchema = z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N}_ -]+$/u, 'Use letters, numbers, spaces, _ or -');
export const EmailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
export const PasswordSchema = z.string().min(10).max(128)
  .refine((value) => /[a-z]/.test(value), 'Include a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Include an uppercase letter')
  .refine((value) => /\d/.test(value), 'Include a number')
  .refine((value) => /[^A-Za-z0-9]/.test(value), 'Include a symbol');
export const RoomCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z2-9]{6}$/);
export const InviteTokenSchema = z.string().regex(/^[a-f0-9]{64}$/i);

/** The browser may submit input intent only; positions and outcomes are server-derived. */
export const PlayerInputSchema = z.object({
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  moveX: z.number().min(-1).max(1),
  moveZ: z.number().min(-1).max(1),
  jump: z.boolean().optional().default(false),
}).strict();
export type PlayerInput = z.infer<typeof PlayerInputSchema>;

export const CreateRoomSchema = z.object({ playerName: PlayerNameSchema }).strict();
export const JoinRoomSchema = z.object({
  playerName: PlayerNameSchema,
  code: RoomCodeSchema.optional(),
  inviteToken: InviteTokenSchema.optional(),
}).strict().refine((value) => Boolean(value.code || value.inviteToken), 'A room code or invite token is required');
export const ReadySchema = z.object({ ready: z.boolean() }).strict();
export const ChatSchema = z.object({ text: z.string().trim().min(1).max(240) }).strict();
export const EmoteSchema = z.object({ emote: z.enum(['wave', 'help', 'cheer', 'follow']) }).strict();
export const PingSchema = z.object({ x: z.number().min(WORLD_LIMITS.minX).max(WORLD_LIMITS.maxX), z: z.number().min(WORLD_LIMITS.minZ).max(WORLD_LIMITS.maxZ), kind: z.enum(['look', 'danger', 'objective']) }).strict();
export const InteractSchema = z.object({ targetId: z.string().min(1).max(32) }).strict();
export const HostActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('privacy'), isPrivate: z.boolean() }).strict(),
  z.object({ action: z.literal('regenerateInvite') }).strict(),
  z.object({ action: z.literal('kick'), playerId: z.string().min(1).max(80) }).strict(),
]);
export const ReportSchema = z.object({ playerId: z.string().min(1).max(80), reason: z.enum(['chat', 'harassment', 'cheating', 'other']) }).strict();

export type SlotKind = 'human' | 'ai';
export type RoomPhase = 'lobby' | 'playing' | 'complete';
export interface PlayerSnapshot {
  id: string;
  name: string;
  slot: number;
  kind: SlotKind;
  connected: boolean;
  ready: boolean;
  x: number;
  y: number;
  z: number;
  health: number;
  downed: boolean;
  ping: number;
  invulnerableUntil: number;
}
export interface RoomSnapshot {
  code: string;
  hostId: string;
  phase: RoomPhase;
  isPrivate: boolean;
  inviteExpiresAt: number;
  players: PlayerSnapshot[];
  crystals: string[];
  gateOpen: boolean;
  checkpoint: { x: number; z: number };
  createdAt: number;
}
export interface AuthIdentity { id: string; name: string; email?: string; guest: boolean; }

/** Easy-to-edit level content. Keep authoritative interaction positions here. */
export const LEVELS = {
  emberCliffs: {
    id: 'ember-cliffs',
    title: 'THE EMBER CLIFFS',
    objective: 'Find 3 Ember Crystals and place them on the altar.',
    start: { x: 0, z: 10 },
    altar: { x: 0, z: -19 },
    gate: { x: 0, z: -31 },
    checkpoint: { x: 0, z: 9 },
    checkpointStone: { x: 0, z: -8 },
    crystals: [
      { id: 'ember-1', x: -8, z: 1, label: 'Ashen Shelf' },
      { id: 'ember-2', x: 8, z: -7, label: 'Cinder Ridge' },
      { id: 'ember-3', x: -4, z: -15, label: 'The Broken Causeway' },
    ],
  },
} as const;

export type LevelId = keyof typeof LEVELS;

export function sanitizePlayerName(raw: string): string {
  const normalized = raw.normalize('NFKC').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 24);
  return normalized.length >= 2 ? normalized : 'Wanderer';
}

export function normalizeMovement(x: number, z: number): { x: number; z: number } {
  const length = Math.hypot(x, z);
  if (length <= 1) return { x, z };
  return { x: x / length, z: z / length };
}

export function canReach(from: { x: number; z: number }, to: { x: number; z: number }, radius = 2.15): boolean {
  return Math.hypot(from.x - to.x, from.z - to.z) <= radius;
}
