import { redis } from './db.js';

const buckets = new Map<string, { count: number; expiresAt: number }>();

/** Small shared limiter for socket actions; Redis is used when configured, memory is a dev fallback. */
export async function consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (redis?.isReady) {
    const bucketKey = `dargaze:rate:${key}`;
    const count = await redis.incr(bucketKey);
    if (count === 1) await redis.expire(bucketKey, windowSeconds);
    return count <= limit;
  }
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    buckets.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.expiresAt < now) buckets.delete(key);
}, 60_000).unref();
