import { describe, expect, it } from 'vitest';
import { RoomManager } from './room-manager.js';
import type { AuthIdentity } from '@dargaze/shared';

const identity = (id: string, name: string): AuthIdentity => ({ id, name, guest: true });

describe('three-slot co-op room manager', () => {
  it('creates exactly three slots, fills a friend into an AI slot, and keeps one slot AI', async () => {
    const rooms = new RoomManager();
    const created = await rooms.create(identity('guest-host', 'Milo'), 'sock-host');
    const joined = await rooms.join(identity('guest-friend', 'Ivo'), 'sock-friend', { code: created.room.code });
    expect(joined.players).toHaveLength(3);
    expect(joined.players.filter((player) => player.kind === 'human')).toHaveLength(2);
    expect(joined.players.filter((player) => player.kind === 'ai')).toHaveLength(1);
  });

  it('rejects a fourth human and lets a disconnected player reclaim their character', async () => {
    const rooms = new RoomManager();
    const created = await rooms.create(identity('guest-host', 'Milo'), 'sock-host');
    await rooms.join(identity('guest-one', 'Ivo'), 'sock-one', { inviteToken: created.inviteToken });
    await rooms.join(identity('guest-two', 'Tavi'), 'sock-two', { code: created.room.code });
    await expect(rooms.join(identity('guest-four', 'Nico'), 'sock-four', { code: created.room.code })).rejects.toThrow('full');

    rooms.disconnect('guest-one', 'sock-one');
    const rejoined = await rooms.join(identity('guest-one', 'Ivo'), 'sock-one-new', { code: created.room.code });
    expect(rejoined.players.find((player) => player.id === 'guest-one')?.connected).toBe(true);
    expect(rejoined.players.find((player) => player.id === 'guest-one')?.slot).toBe(1);
  });

  it('keeps private rooms out of browse results and invalidates a regenerated invite', async () => {
    const rooms = new RoomManager();
    const created = await rooms.create(identity('guest-host', 'Milo'), 'sock-host');
    expect(rooms.listPublicRooms()).toHaveLength(0);
    rooms.hostAction('guest-host', 'privacy', { isPrivate: false });
    expect(rooms.listPublicRooms()[0]?.code).toBe(created.room.code);
    const regenerated = rooms.hostAction('guest-host', 'regenerateInvite').inviteToken!;
    await expect(rooms.join(identity('guest-old-link', 'Ivo'), 'sock-old', { inviteToken: created.inviteToken })).rejects.toThrow('unavailable');
    await expect(rooms.join(identity('guest-new-link', 'Ivo'), 'sock-new', { inviteToken: regenerated })).resolves.toMatchObject({ code: created.room.code });
  });

  it('requires host authority and all connected humans to ready before starting', async () => {
    const rooms = new RoomManager();
    const created = await rooms.create(identity('guest-host', 'Milo'), 'sock-host');
    await rooms.join(identity('guest-friend', 'Ivo'), 'sock-friend', { code: created.room.code });
    expect(() => rooms.start('guest-friend')).toThrow('host');
    expect(() => rooms.start('guest-host')).toThrow('ready');
    rooms.setReady('guest-friend', true);
    expect(rooms.start('guest-host').phase).toBe('playing');
  });
});
