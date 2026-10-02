import { Pool } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';
import { config } from './config.js';

export const pool = config.databaseUrl
  ? new Pool({ connectionString: config.databaseUrl, max: 12, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
  : null;

export let redis: RedisClientType | null = null;

export async function connectRedis(): Promise<void> {
  if (!config.redisUrl) return;
  const client = createClient({ url: config.redisUrl });
  client.on('error', () => console.error('[redis] connection error'));
  await client.connect();
  redis = client as RedisClientType;
}

export async function attachRedisAdapter(io: Server): Promise<void> {
  if (!redis) return;
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  await Promise.all([pub.connect(), sub.connect()]);
  io.adapter(createAdapter(pub, sub));
}

export async function checkDatabase(): Promise<void> {
  if (!pool) return;
  await pool.query('select 1');
}

export async function closeConnections(): Promise<void> {
  await Promise.allSettled([pool?.end(), redis?.quit()]);
}
