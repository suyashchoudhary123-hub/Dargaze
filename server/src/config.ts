const list = (value: string | undefined, fallback: string[]) => (value ?? fallback.join(',')).split(',').map((part) => part.trim()).filter(Boolean);

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3001),
  frontendOrigins: list(process.env.FRONTEND_ORIGINS, ['http://localhost:5173']),
  jwtSecret: process.env.JWT_SECRET ?? 'local-development-only-change-this-secret-before-deploying',
  accessTokenTtl: '15m' as const,
  refreshTokenDays: Number(process.env.REFRESH_TOKEN_DAYS ?? 30),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  smtpUrl: process.env.SMTP_URL,
  emailFrom: process.env.EMAIL_FROM ?? 'Dargaze <no-reply@dargaze.local>',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:5173',
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
  turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
  totpEncryptionKey: process.env.TOTP_ENCRYPTION_KEY,
  trustProxy: process.env.TRUST_PROXY === 'true',
};

/** Preview origins are admitted only in development; production remains an exact allow-list. */
export function isAllowedOrigin(origin: string): boolean {
  if (config.frontendOrigins.includes(origin)) return true;
  return config.nodeEnv === 'development' && /^https:\/\/\d+-[a-z0-9-]+\.e2b\.app$/i.test(origin);
}

if (config.nodeEnv === 'production') {
  if (config.jwtSecret.length < 32 || /replace|change-this|development-only/i.test(config.jwtSecret)) throw new Error('Set a unique high-entropy JWT_SECRET before production startup');
  if (!config.databaseUrl || !config.redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required in production');
  if (!config.totpEncryptionKey || config.totpEncryptionKey.length < 32 || /replace/i.test(config.totpEncryptionKey)) throw new Error('Set a unique TOTP_ENCRYPTION_KEY before production startup');
  if (!config.publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must use HTTPS in production');
  if (!config.trustProxy) throw new Error('TRUST_PROXY=true is required behind the production TLS proxy');
}
