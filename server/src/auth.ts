import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { EmailSchema, PasswordSchema, PlayerNameSchema, sanitizePlayerName, type AuthIdentity } from '@dargaze/shared';
import { config } from './config.js';
import { pool } from './db.js';
import { mailerConfigured, sendSecurityEmail } from './mailer.js';

const router = Router();
const refreshCookie = 'dargaze_refresh';
const csrfCookie = 'dargaze_csrf';
const oauthStateCookie = 'dargaze_oauth_state';
const cookieSecure = config.nodeEnv === 'production';
const sessionDays = Math.max(1, Math.min(config.refreshTokenDays, 90));
const google = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);

export interface AuthClaims extends JwtPayload {
  sub: string;
  name: string;
  email?: string;
  guest: boolean;
  sid?: string;
}
export type AuthRequest = Request & { auth?: AuthClaims };

const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: PlayerNameSchema,
  captchaToken: z.string().max(4096).optional(),
}).strict();
const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  captchaToken: z.string().max(4096).optional(),
}).strict();
const GuestSchema = z.object({ name: PlayerNameSchema.optional() }).strict();
const ForgotSchema = z.object({ email: EmailSchema, captchaToken: z.string().max(4096).optional() }).strict();
const ResetSchema = z.object({ token: z.string().min(32).max(256), password: PasswordSchema }).strict();
const TotpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

function requireDatabase(): NonNullable<typeof pool> {
  if (!pool) throw Object.assign(new Error('Account storage is not configured'), { status: 503 });
  return pool;
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function newToken(): string { return randomBytes(40).toString('base64url'); }
function safeError(status: number, message: string): Error & { status: number } { return Object.assign(new Error(message), { status }); }
function setSessionCookies(res: Response, refresh: string, csrf: string): void {
  const common = { secure: cookieSecure, sameSite: 'strict' as const };
  res.cookie(refreshCookie, refresh, { ...common, httpOnly: true, path: '/api/auth', maxAge: sessionDays * 24 * 60 * 60 * 1000 });
  res.cookie(csrfCookie, csrf, { ...common, httpOnly: false, path: '/api/auth', maxAge: sessionDays * 24 * 60 * 60 * 1000 });
}
function clearSessionCookies(res: Response): void {
  const common = { secure: cookieSecure, sameSite: 'strict' as const, path: '/api/auth' };
  res.clearCookie(refreshCookie, { ...common, httpOnly: true });
  res.clearCookie(csrfCookie, { ...common, httpOnly: false });
}
function signAccess(user: { id: string; display_name: string; email?: string | null }, sid?: string): string {
  const payload: AuthClaims = {
    sub: user.id,
    name: sanitizePlayerName(user.display_name),
    ...(user.email ? { email: user.email } : {}),
    guest: false,
    ...(sid ? { sid } : {}),
  };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.accessTokenTtl, issuer: 'dargaze-api', audience: 'dargaze-client' });
}
export function verifyAccessToken(token: string): AuthClaims {
  const payload = jwt.verify(token, config.jwtSecret, { issuer: 'dargaze-api', audience: 'dargaze-client', algorithms: ['HS256'] });
  if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.name !== 'string') throw new Error('Invalid access token');
  return payload as AuthClaims;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) { res.status(401).json({ error: 'Authentication required' }); return; }
  try { req.auth = verifyAccessToken(token); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired access token' }); }
}
function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const cookie = req.cookies?.[csrfCookie];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || cookie !== header) { res.status(403).json({ error: 'CSRF check failed' }); return; }
  next();
}
function identity(claims: AuthClaims): AuthIdentity {
  return { id: claims.sub, name: sanitizePlayerName(claims.name), ...(claims.email ? { email: claims.email } : {}), guest: claims.guest };
}
async function issueSession(res: Response, user: { id: string; display_name: string; email?: string | null }, deviceLabel: string): Promise<{ accessToken: string; user: AuthIdentity }> {
  const database = requireDatabase();
  const refresh = newToken();
  const csrf = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  const inserted = await database.query<{ id: string }>(
    'INSERT INTO refresh_sessions (user_id, token_hash, device_label, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [user.id, sha256(refresh), deviceLabel.slice(0, 120), expiresAt],
  );
  setSessionCookies(res, refresh, csrf);
  const claims: AuthClaims = { sub: user.id, name: sanitizePlayerName(user.display_name), ...(user.email ? { email: user.email } : {}), guest: false };
  return { accessToken: jwt.sign({ ...claims, sid: inserted.rows[0]!.id }, config.jwtSecret, { expiresIn: config.accessTokenTtl, issuer: 'dargaze-api', audience: 'dargaze-client' }), user: identity(claims) };
}

async function verifyCaptcha(token?: string, ip?: string): Promise<boolean> {
  if (!config.turnstileSecret) return true;
  if (!token) return false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: config.turnstileSecret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    const result = await response.json() as { success?: boolean };
    return result.success === true;
  } catch { return false; }
}

function base32Encode(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; let output = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0; let value = 0; const out: number[] = [];
  for (const char of input.replace(/=+$/g, '').toUpperCase()) { const index = alphabet.indexOf(char); if (index < 0) throw new Error('Bad TOTP secret'); value = (value << 5) | index; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function encryptionKey(): Buffer {
  if (!config.totpEncryptionKey || config.totpEncryptionKey.length < 32) throw safeError(503, 'Two-factor encryption is not configured');
  return createHash('sha256').update(config.totpEncryptionKey).digest();
}
function encryptSecret(secret: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decryptSecret(value: string): string {
  const [ivText, tagText, encryptedText] = value.split('.');
  if (!ivText || !tagText || !encryptedText) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}
function totp(secret: string, epoch = Date.now()): string {
  const counter = Math.floor(epoch / 30_000); const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest(); const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}
function verifyTotp(secret: string, code: string): boolean {
  const now = Date.now(); return [-30_000, 0, 30_000].some((offset) => totp(secret, now + offset) === code);
}

router.post('/guest', async (req, res) => {
  const parsed = GuestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid guest name', details: parsed.error.flatten().fieldErrors }); return; }
  const id = `guest-${randomUUID()}`;
  const claims: AuthClaims = { sub: id, name: sanitizePlayerName(parsed.data.name ?? 'Wanderer'), guest: true };
  res.status(200).json({ accessToken: jwt.sign(claims, config.jwtSecret, { expiresIn: '2h', issuer: 'dargaze-api', audience: 'dargaze-client' }), user: identity(claims), expiresIn: 7200 });
});

router.post('/register', async (req, res, next) => {
  try {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Check the form fields', details: parsed.error.flatten().fieldErrors }); return; }
    if (!await verifyCaptcha(parsed.data.captchaToken, req.ip)) { res.status(400).json({ error: 'CAPTCHA verification failed' }); return; }
    if (!mailerConfigured()) { res.status(503).json({ error: 'Email delivery is not configured. Use guest sign-in or configure SMTP.' }); return; }
    const database = requireDatabase();
    const hash = await bcrypt.hash(parsed.data.password, 12);
    const inserted = await database.query<{ id: string }>(
      'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [parsed.data.email, sanitizePlayerName(parsed.data.name), hash],
    );
    const token = newToken();
    await database.query('INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'24 hours\')', [sha256(token), inserted.rows[0]!.id]);
    const link = `${config.publicUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
    await sendSecurityEmail(parsed.data.email, 'Verify your Dargaze account', `Open this one-time link to verify your account (expires in 24 hours):\n\n${link}`);
    res.status(201).json({ message: 'Account created. Check your email for a verification link before signing in.' });
  } catch (error) { next(error); }
});

router.get('/verify', async (req, res, next) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token || token.length > 256) { res.status(400).send('This verification link is invalid or expired.'); return; }
    const database = requireDatabase();
    const result = await database.query<{ user_id: string }>('DELETE FROM email_verification_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id', [sha256(token)]);
    if (!result.rowCount) { res.status(400).send('This verification link is invalid or expired.'); return; }
    await database.query('UPDATE users SET email_verified = TRUE, updated_at = NOW() WHERE id = $1', [result.rows[0]!.user_id]);
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Dargaze verified</title><body style="background:#100d0f;color:#f7eee9;font:18px system-ui;display:grid;place-items:center;min-height:90vh"><main><h1>Account verified</h1><p>You can return to Dargaze and sign in.</p></main></body>');
  } catch (error) { next(error); }
});

router.post('/login', async (req, res, next) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid email or password' }); return; }
    if (!await verifyCaptcha(parsed.data.captchaToken, req.ip)) { res.status(400).json({ error: 'CAPTCHA verification failed' }); return; }
    const database = requireDatabase();
    const result = await database.query<{ id: string; email: string; display_name: string; password_hash: string | null; email_verified: boolean; totp_enabled: boolean; totp_secret_enc: string | null; failed_login_count: number; locked_until: Date | null }>(
      'SELECT id, email, display_name, password_hash, email_verified, totp_enabled, totp_secret_enc, failed_login_count, locked_until FROM users WHERE email = $1 AND deleted_at IS NULL',
      [parsed.data.email],
    );
    const user = result.rows[0];
    if (!user || !user.password_hash) { res.status(401).json({ error: 'Invalid email or password' }); return; }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) { res.status(429).json({ error: 'Too many attempts. Please try again later.' }); return; }
    if (!await bcrypt.compare(parsed.data.password, user.password_hash)) {
      const attempts = user.failed_login_count + 1;
      const delaySeconds = attempts >= 5 ? Math.min(15 * 60, 15 * 2 ** Math.min(attempts - 5, 6)) : 0;
      await database.query('UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3', [attempts, delaySeconds ? new Date(Date.now() + delaySeconds * 1000) : null, user.id]);
      res.status(401).json({ error: 'Invalid email or password' }); return;
    }
    if (!user.email_verified) { res.status(403).json({ error: 'Please verify your email before signing in.' }); return; }
    if (user.totp_enabled) {
      if (!parsed.data.totpCode) { res.status(401).json({ error: 'Two-factor code required', twoFactorRequired: true }); return; }
      if (!user.totp_secret_enc || !verifyTotp(decryptSecret(user.totp_secret_enc), parsed.data.totpCode)) { res.status(401).json({ error: 'Invalid two-factor code', twoFactorRequired: true }); return; }
    }
    await database.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1', [user.id]);
    const session = await issueSession(res, user, req.get('user-agent') ?? 'Browser');
    res.json(session);
  } catch (error) { next(error); }
});

router.post('/refresh', requireCsrf, async (req, res, next) => {
  const database = pool;
  const oldToken = req.cookies?.[refreshCookie] as string | undefined;
  if (!database || !oldToken) { clearSessionCookies(res); res.status(401).json({ error: 'Session expired' }); return; }
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ id: string; user_id: string; display_name: string; email: string; expires_at: Date }>(
      'SELECT s.id, s.user_id, u.display_name, u.email, s.expires_at FROM refresh_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND u.deleted_at IS NULL FOR UPDATE OF s',
      [sha256(oldToken)],
    );
    const current = found.rows[0];
    if (!current || current.expires_at.getTime() <= Date.now()) {
      if (current) await client.query('DELETE FROM refresh_sessions WHERE id = $1', [current.id]);
      await client.query('COMMIT'); clearSessionCookies(res); res.status(401).json({ error: 'Session expired' }); return;
    }
    const refresh = newToken(); const csrf = randomBytes(24).toString('base64url');
    const updated = await client.query('UPDATE refresh_sessions SET token_hash = $1, last_seen_at = NOW(), expires_at = NOW() + ($2 * INTERVAL \'1 day\') WHERE id = $3 AND token_hash = $4', [sha256(refresh), sessionDays, current.id, sha256(oldToken)]);
    if (updated.rowCount !== 1) { await client.query('DELETE FROM refresh_sessions WHERE user_id = $1', [current.user_id]); await client.query('COMMIT'); clearSessionCookies(res); res.status(401).json({ error: 'Session rotation failed' }); return; }
    await client.query('COMMIT');
    setSessionCookies(res, refresh, csrf);
    const claims: AuthClaims = { sub: current.user_id, name: sanitizePlayerName(current.display_name), email: current.email, guest: false, sid: current.id };
    res.json({ accessToken: jwt.sign(claims, config.jwtSecret, { expiresIn: config.accessTokenTtl, issuer: 'dargaze-api', audience: 'dargaze-client' }), user: identity(claims) });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.post('/logout', requireCsrf, async (req, res, next) => {
  try {
    const token = req.cookies?.[refreshCookie] as string | undefined;
    if (token && pool) await pool.query('DELETE FROM refresh_sessions WHERE token_hash = $1', [sha256(token)]);
    clearSessionCookies(res); res.status(204).end();
  } catch (error) { next(error); }
});

router.post('/password/forgot', async (req, res, next) => {
  try {
    const parsed = ForgotSchema.safeParse(req.body);
    if (!parsed.success) { res.status(200).json({ message: 'If an account matches that email, a reset link will be sent.' }); return; }
    if (!await verifyCaptcha(parsed.data.captchaToken, req.ip)) { res.status(400).json({ error: 'CAPTCHA verification failed' }); return; }
    if (pool && mailerConfigured()) {
      const found = await pool.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE email = $1 AND deleted_at IS NULL', [parsed.data.email]);
      if (found.rows[0]) {
        const token = newToken();
        await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [found.rows[0].id]);
        await pool.query('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 minutes\')', [sha256(token), found.rows[0].id]);
        await sendSecurityEmail(found.rows[0].email, 'Reset your Dargaze password', `Use this one-time link within 30 minutes:\n\n${config.publicUrl}/?reset=${encodeURIComponent(token)}`);
      }
    }
    res.json({ message: 'If an account matches that email, a reset link will be sent.' });
  } catch (error) { next(error); }
});

router.post('/password/reset', async (req, res, next) => {
  const parsed = ResetSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid or expired reset link, or password does not meet requirements.' }); return; }
  const database = pool;
  if (!database) { res.status(503).json({ error: 'Account storage is not configured' }); return; }
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const token = await client.query<{ user_id: string }>('DELETE FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id', [sha256(parsed.data.token)]);
    if (!token.rows[0]) { await client.query('ROLLBACK'); res.status(400).json({ error: 'Invalid or expired reset link.' }); return; }
    const hash = await bcrypt.hash(parsed.data.password, 12);
    await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, token.rows[0].user_id]);
    await client.query('DELETE FROM refresh_sessions WHERE user_id = $1', [token.rows[0].user_id]);
    await client.query('COMMIT'); clearSessionCookies(res); res.json({ message: 'Password updated. Please sign in again.' });
  } catch (error) { await client.query('ROLLBACK'); next(error); }
  finally { client.release(); }
});

router.get('/me', requireAuth, (req: AuthRequest, res) => res.json({ user: identity(req.auth!) }));

router.get('/sessions', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (req.auth!.guest) { res.json({ sessions: [] }); return; }
    const result = await requireDatabase().query<{ id: string; device_label: string; created_at: Date; last_seen_at: Date; expires_at: Date }>(
      'SELECT id, device_label, created_at, last_seen_at, expires_at FROM refresh_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC', [req.auth!.sub],
    );
    res.json({ sessions: result.rows.map((row) => ({ ...row, current: row.id === req.auth!.sid })) });
  } catch (error) { next(error); }
});

router.post('/logout-everywhere', requireAuth, requireCsrf, async (req: AuthRequest, res, next) => {
  try {
    if (!req.auth!.guest) await requireDatabase().query('DELETE FROM refresh_sessions WHERE user_id = $1', [req.auth!.sub]);
    clearSessionCookies(res); res.status(204).end();
  } catch (error) { next(error); }
});

router.delete('/account', requireAuth, requireCsrf, async (req: AuthRequest, res, next) => {
  try {
    if (req.auth!.guest) { res.status(400).json({ error: 'Guest accounts do not have persistent data to delete.' }); return; }
    const parsed = z.object({ confirm: z.literal('DELETE') }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Type DELETE to confirm account deletion.' }); return; }
    const database = requireDatabase(); const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET deleted_at = NOW(), email = NULL, display_name = \'Deleted account\', password_hash = NULL, google_sub = NULL, totp_secret_enc = NULL, totp_enabled = FALSE, failed_login_count = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1', [req.auth!.sub]);
      await client.query('DELETE FROM refresh_sessions WHERE user_id = $1', [req.auth!.sub]);
      await client.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [req.auth!.sub]);
      await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [req.auth!.sub]);
      await client.query('DELETE FROM player_progress WHERE user_id = $1', [req.auth!.sub]);
      await client.query('COMMIT'); clearSessionCookies(res); res.status(204).end();
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) { next(error); }
});

router.post('/2fa/setup', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (req.auth!.guest) { res.status(400).json({ error: 'Register an account to enable two-factor authentication.' }); return; }
    const secret = base32Encode(randomBytes(20));
    const database = requireDatabase();
    await database.query('UPDATE users SET totp_secret_enc = $1, totp_enabled = FALSE WHERE id = $2', [encryptSecret(secret), req.auth!.sub]);
    const label = encodeURIComponent(`Dargaze:${req.auth!.email ?? req.auth!.name}`);
    res.json({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Dargaze&algorithm=SHA1&digits=6&period=30` });
  } catch (error) { next(error); }
});

router.post('/2fa/enable', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const parsed = TotpCodeSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: 'Enter a 6-digit code.' }); return; }
    const database = requireDatabase();
    const result = await database.query<{ totp_secret_enc: string | null }>('SELECT totp_secret_enc FROM users WHERE id = $1', [req.auth!.sub]);
    const encrypted = result.rows[0]?.totp_secret_enc;
    if (!encrypted || !verifyTotp(decryptSecret(encrypted), parsed.data.code)) { res.status(400).json({ error: 'Code did not match.' }); return; }
    await database.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [req.auth!.sub]); res.json({ enabled: true });
  } catch (error) { next(error); }
});

router.post('/2fa/disable', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const parsed = TotpCodeSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: 'Enter a 6-digit code.' }); return; }
    const database = requireDatabase();
    const result = await database.query<{ totp_secret_enc: string | null }>('SELECT totp_secret_enc FROM users WHERE id = $1', [req.auth!.sub]);
    const encrypted = result.rows[0]?.totp_secret_enc;
    if (!encrypted || !verifyTotp(decryptSecret(encrypted), parsed.data.code)) { res.status(400).json({ error: 'Code did not match.' }); return; }
    await database.query('UPDATE users SET totp_enabled = FALSE, totp_secret_enc = NULL WHERE id = $1', [req.auth!.sub]); res.json({ enabled: false });
  } catch (error) { next(error); }
});

router.get('/google', (_req, res) => {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) { res.status(503).json({ error: 'Google sign-in is not configured' }); return; }
  const state = randomBytes(24).toString('base64url');
  res.cookie(oauthStateCookie, state, { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/api/auth/google', maxAge: 10 * 60 * 1000 });
  const url = google.generateAuthUrl({ access_type: 'offline', scope: ['openid', 'email', 'profile'], prompt: 'select_account', state });
  res.redirect(url);
});

router.get('/google/callback', async (req, res, next) => {
  try {
    const stateCookie = req.cookies?.[oauthStateCookie] as string | undefined;
    res.clearCookie(oauthStateCookie, { httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/api/auth/google' });
    if (!stateCookie || typeof req.query.state !== 'string' || req.query.state !== stateCookie) { res.redirect(`${config.publicUrl}/?authError=google`); return; }
    if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri || typeof req.query.code !== 'string') { res.redirect(`${config.publicUrl}/?authError=google`); return; }
    const { tokens } = await google.getToken(req.query.code);
    if (!tokens.id_token) { res.redirect(`${config.publicUrl}/?authError=google`); return; }
    const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) { res.redirect(`${config.publicUrl}/?authError=google`); return; }
    const database = requireDatabase();
    let result = await database.query<{ id: string; display_name: string; email: string }>('SELECT id, display_name, email FROM users WHERE google_sub = $1 AND deleted_at IS NULL', [payload.sub]);
    if (!result.rows[0]) {
      result = await database.query<{ id: string; display_name: string; email: string }>(
        'INSERT INTO users (email, display_name, google_sub, email_verified) VALUES ($1, $2, $3, TRUE) ON CONFLICT (email) DO UPDATE SET google_sub = COALESCE(users.google_sub, EXCLUDED.google_sub), email_verified = TRUE, updated_at = NOW() WHERE users.deleted_at IS NULL RETURNING id, display_name, email',
        [payload.email.toLowerCase(), sanitizePlayerName(payload.name ?? payload.email.split('@')[0] ?? 'Wanderer'), payload.sub],
      );
    }
    if (!result.rows[0]) { res.redirect(`${config.publicUrl}/?authError=google`); return; }
    const session = await issueSession(res, result.rows[0], 'Google sign-in');
    res.redirect(`${config.publicUrl}/#access=${encodeURIComponent(session.accessToken)}`);
  } catch (error) { next(error); }
});

export const authRouter = router;
