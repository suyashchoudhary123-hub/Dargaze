import { describe, expect, it } from 'vitest';
import { ChatSchema, JoinRoomSchema, PasswordSchema, PlayerInputSchema, PlayerNameSchema, normalizeMovement, sanitizePlayerName } from './index.js';

describe('shared validation', () => {
  it('accepts well-formed player input and rejects impossible ranges or extra fields', () => {
    expect(PlayerInputSchema.safeParse({ seq: 1, moveX: 0.5, moveZ: -1, jump: true }).success).toBe(true);
    expect(PlayerInputSchema.safeParse({ seq: 1, moveX: 8, moveZ: 0 }).success).toBe(false);
    expect(PlayerInputSchema.safeParse({ seq: 1, moveX: 0, moveZ: 0, position: { x: 999 } }).success).toBe(false);
  });

  it('requires a room locator and a safe display name', () => {
    expect(JoinRoomSchema.safeParse({ playerName: 'Milo', code: 'K7Q9PD' }).success).toBe(true);
    expect(JoinRoomSchema.safeParse({ playerName: 'Milo' }).success).toBe(false);
    expect(PlayerNameSchema.safeParse('<script>alert(1)</script>').success).toBe(false);
  });

  it('enforces strong passwords and bounded chat text', () => {
    expect(PasswordSchema.safeParse('Ash!River2026').success).toBe(true);
    expect(PasswordSchema.safeParse('short').success).toBe(false);
    expect(ChatSchema.safeParse({ text: 'Stay close.' }).success).toBe(true);
    expect(ChatSchema.safeParse({ text: 'x'.repeat(241) }).success).toBe(false);
  });

  it('normalizes movement and strips unsafe controls from names', () => {
    expect(normalizeMovement(2, 0)).toEqual({ x: 1, z: 0 });
    expect(sanitizePlayerName('<Milo>\u0000')).toBe('Milo');
  });
});
