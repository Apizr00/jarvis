// src/api/health.js
// Pemeriksaan Kesihatan Automatik (Health Checks)
// Menyemak sambungan DB, Redis, dan external API untuk memantau ketersediaan bot.

const db = require('../db');
const { errorMetrics } = require('../utils/logger');
const { getApiStatus } = require('./status');

/**
 * Perform a comprehensive health check of all system components.
 *
 * @param {object} [bot] - Telegram bot instance (optional)
 * @returns {Promise<{status:string, uptime:number, timestamp:string, components:object, metrics:object}>}
 */
async function getHealthStatus(bot) {
  const checks = {
    database: await checkDatabase(),
    redis: await checkRedis(),
  };

  // Determine overall status
  const critical = ['database'];
  const allOk = critical.every(c => checks[c]?.status === 'healthy');

  return {
    status: allOk ? 'healthy' : 'degraded',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '3.0.0',
    components: checks,
    metrics: {
      errors: errorMetrics.getStats(),
      memory: getMemoryMetrics(),
    },
  };
}

/**
 * Check PostgreSQL connection health.
 */
async function checkDatabase() {
  try {
    const start = Date.now();
    await db.pool.query('SELECT 1');
    const latency = Date.now() - start;

    return {
      status: 'healthy',
      latencyMs: latency,
      message: 'Connected',
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      latencyMs: null,
      message: err.message,
      errorCode: err.code,
    };
  }
}

/**
 * Check Redis connection health (optional).
 */
async function checkRedis() {
  try {
    const redis = require('../redis');
    if (!redis.redis) {
      return {
        status: 'not_configured',
        message: 'Redis URL not set',
      };
    }

    const start = Date.now();
    await redis.redis.ping();
    const latency = Date.now() - start;

    return {
      status: 'healthy',
      latencyMs: latency,
      message: 'Connected',
    };
  } catch (err) {
    // Redis is optional — failure is a warning, not critical
    return {
      status: 'unavailable',
      latencyMs: null,
      message: err.message,
    };
  }
}

/**
 * Get memory usage metrics.
 */
function getMemoryMetrics() {
  const usage = process.memoryUsage();
  return {
    rssMB: Math.round(usage.rss / 1024 / 1024 * 100) / 100,
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
    externalMB: Math.round(usage.external / 1024 / 1024 * 100) / 100,
  };
}

/**
 * Format health status into a human-readable string for Telegram.
 */
function formatHealthMessage(health) {
  const lines = ['*🏥 System Health*', ''];

  const statusEmoji = health.status === 'healthy' ? '🟢' : '🟡';
  lines.push(`${statusEmoji} Status: *${health.status.toUpperCase()}*`);
  lines.push(`⏱ Uptime: ${formatUptime(health.uptime)}`);
  lines.push(`🌍 Environment: \`${health.environment}\``);
  lines.push('');

  // Components
  lines.push('*Components:*');
  for (const [name, check] of Object.entries(health.components)) {
    const icon = check.status === 'healthy' ? '✅' :
      check.status === 'unavailable' ? '⚠️' : '❌';
    const latency = check.latencyMs !== null ? ` (${check.latencyMs}ms)` : '';
    lines.push(`  ${icon} ${name}: ${check.status}${latency}`);
  }
  lines.push('');

  // Error metrics
  const errStats = health.metrics.errors;
  lines.push('*Error Metrics:*');
  lines.push(`  📊 Total errors: ${errStats.total}`);
  lines.push(`  📊 Last hour: ${errStats.lastHour}`);
  lines.push('');

  // Memory
  const mem = health.metrics.memory;
  lines.push('*Memory:*');
  lines.push(`  💾 RSS: ${mem.rssMB} MB`);
  lines.push(`  💾 Heap: ${mem.heapUsedMB}/${mem.heapTotalMB} MB`);

  return lines.join('\n');
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

module.exports = { getHealthStatus, formatHealthMessage };
