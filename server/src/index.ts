import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { authRouter, verifyAccessToken } from './auth.js';
import { config, isAllowedOrigin } from './config.js';
import { attachRedisAdapter, checkDatabase, closeConnections, connectRedis, pool, redis } from './db.js';
import { attachSocketServer } from './socket.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'connect-src': ["'self'", 'https:', 'wss:'],
      'font-src': ["'self'", 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'object-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: config.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || isAllowedOrigin(origin)) callback(null, true);
    else callback(new Error('Origin is not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  maxAge: 600,
}));
app.use(express.json({ limit: '16kb', strict: true }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (config.nodeEnv === 'production' && req.path !== '/api/health' && req.secure !== true && req.get('x-forwarded-proto') !== 'https') {
    res.status(400).json({ error: 'HTTPS is required' }); return;
  }
  res.setHeader('X-Request-ID', req.get('x-request-id')?.slice(0, 80) || randomUUID());
  next();
});

function redisLimitStore(prefix: string): RedisStore | undefined {
  if (!config.redisUrl) return undefined;
  return new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      const client = redis;
      if (!client?.isReady) throw new Error('Redis rate-limit store is unavailable');
      return client.sendCommand(args as Parameters<typeof client.sendCommand>[0]) as Promise<string | number | boolean | (string | number | boolean)[]>;
    },
  });
}
function authenticatedRateLimitKey(req: Request): string | undefined {
  const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return undefined;
  try { return verifyAccessToken(token).sub; } catch { return undefined; }
}
function redisStoreOption(prefix: string): { store: RedisStore } | Record<string, never> {
  const store = redisLimitStore(prefix);
  return store ? { store } : {};
}
const generalLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, ...redisStoreOption('dargaze:rl:api:'), message: { error: 'Too many requests. Try again shortly.' } });
const userLimiter = rateLimit({
  windowMs: 60_000,
  limit: 90,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  ...redisStoreOption('dargaze:rl:user:'),
  skip: (req) => !authenticatedRateLimitKey(req),
  keyGenerator: (req) => `user:${authenticatedRateLimitKey(req) ?? 'anonymous'}`,
  message: { error: 'Too many requests for this account. Try again shortly.' },
});
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, ...redisStoreOption('dargaze:rl:auth:'), message: { error: 'Too many authentication attempts. Try again later.' } });
app.use('/api', generalLimiter, userLimiter);
app.get('/api/health', async (_req, res) => {
  let db = 'not-configured'; let cache = 'not-configured';
  try { if (pool) { await pool.query('select 1'); db = 'ok'; } } catch { db = 'unavailable'; }
  try {
    const { redis } = await import('./db.js');
    if (redis) cache = redis.isReady ? 'ok' : 'unavailable';
  } catch { cache = 'unavailable'; }
  res.json({ status: 'ok', service: 'dargaze-api', database: db, redis: cache, time: new Date().toISOString() });
});
app.use('/api/auth', authLimiter, authRouter);
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
  const status = error.status ?? 500;
  if (status >= 500) console.error(`[http] request failed id=${String(res.getHeader('X-Request-ID') ?? 'unknown')} method=${req.method} path=${req.path} status=${status} error=${error.name}`);
  res.status(status).json({ error: status >= 500 && config.nodeEnv === 'production' ? 'Internal server error' : error.message });
});

const httpServer = createServer(app);
const io = attachSocketServer(httpServer);

async function start(): Promise<void> {
  try {
    await connectRedis();
    await attachRedisAdapter(io);
    await checkDatabase();
    httpServer.listen(config.port, '0.0.0.0', () => console.info(`[api] listening on 0.0.0.0:${config.port} (${config.nodeEnv})`));
  } catch (error) {
    console.error('[api] startup failed; check service connectivity and environment configuration');
    process.exitCode = 1;
  }
}

async function shutdown(signal: string): Promise<void> {
  console.info(`[api] ${signal}; shutting down`);
  io.close();
  httpServer.close();
  await closeConnections();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
void start();
