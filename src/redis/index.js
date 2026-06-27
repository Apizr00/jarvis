// src/redis/index.js
// Redis connection and cache helpers
require('dotenv').config();
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) {
      console.warn('⚠️  Redis connection failed after 5 retries — running without cache.');
      return null; // stop retrying
    }
    return Math.min(times * 200, 2000);
  },
  lazyConnect: true, // we connect manually
});

let connected = false;

async function connect() {
  try {
    await redis.connect();
    connected = true;
    console.log('📦 Redis connected — caching layer active');
  } catch (err) {
    console.warn('⚠️  Redis unavailable (' + err.message + ') — running without cache.');
    connected = false;
  }
}

/**
 * Get cached user facts. Returns null on miss or if Redis is down.
 * @param {string} userId
 * @returns {Promise<Array<{key:string,value:string}>|null>}
 */
async function getFactsCache(userId) {
  if (!connected) return null;
  try {
    const raw = await redis.get('jarvis:facts:' + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Cache user facts with a 10-minute TTL.
 * @param {string} userId
 * @param {Array<{key:string,value:string}>} facts
 */
async function setFactsCache(userId, facts) {
  if (!connected) return;
  try {
    await redis.set('jarvis:facts:' + userId, JSON.stringify(facts), 'EX', 600);
  } catch {
    // silently ignore cache write failures
  }
}

/**
 * Invalidate the facts cache for a user (called after set_fact).
 * @param {string} userId
 */
async function invalidateFactsCache(userId) {
  if (!connected) return;
  try {
    await redis.del('jarvis:facts:' + userId);
  } catch {
    // silently ignore
  }
}

module.exports = { redis, connect, getFactsCache, setFactsCache, invalidateFactsCache };
