import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { verifyAccessToken } from './auth.js';
import { config } from './config.js';

describe('access-token authentication', () => {
  it('accepts correctly scoped short-lived client tokens', () => {
    const token = jwt.sign({ sub: 'guest-1', name: 'Milo', guest: true }, config.jwtSecret, {
      expiresIn: 60, issuer: 'dargaze-api', audience: 'dargaze-client',
    });
    expect(verifyAccessToken(token).sub).toBe('guest-1');
  });

  it('rejects tokens from a different audience and expired tokens', () => {
    const wrongAudience = jwt.sign({ sub: 'u1', name: 'Milo', guest: false }, config.jwtSecret, { expiresIn: 60, audience: 'other' });
    const expired = jwt.sign({ sub: 'u1', name: 'Milo', guest: false }, config.jwtSecret, { expiresIn: -1, issuer: 'dargaze-api', audience: 'dargaze-client' });
    expect(() => verifyAccessToken(wrongAudience)).toThrow();
    expect(() => verifyAccessToken(expired)).toThrow();
  });
});
