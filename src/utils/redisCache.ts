import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const NO_CACHE = process.env.NO_CACHE === 'true' || process.env.NO_CACHE === undefined;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let redis: Redis | null = null;
if (!NO_CACHE) {
  redis = new Redis(REDIS_URL);
}

export function getCacheTTL(strategyName: string): number {
  // Return TTL in seconds
  switch (strategyName.toLowerCase()) {
    case 'pumpfunswapstrategy':
    case 'pumpfunbondingcurveswapstrategy':
    case 'raydiumlaunchlabswapstrategy':
    case 'moonshotswapstrategy':
      return 30; // 30 seconds
    case 'raydiumswapstrategy':
    case 'pumpswapstrategy':
      return 1800; // 30 minutes
    default:
      return 120; // 2 minutes
  }
}

export async function getCache(key: string): Promise<any | null> {
  if (NO_CACHE || !redis) return null;
  const val = await redis.get(key);
  if (!val) return null;
  try {
    console.log(`Cache hit for ${key}`);
    return JSON.parse(val);
  } catch {
    return null;
  }
}

export async function setCache(key: string, value: any, ttlSeconds: number): Promise<void> {
  if (NO_CACHE || !redis) return;
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
} 