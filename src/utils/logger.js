// src/utils/logger.js
// Structured Logging — menggantikan console.log/error dengan format JSON
// untuk memudahkan debugging, monitoring, dan log aggregation.
//
// Level: debug < info < warn < error < fatal
// Set LOG_LEVEL dalam .env untuk menapis (default: info)

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const MIN_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || LOG_LEVELS.info;

function formatLog(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    env: process.env.NODE_ENV || 'development',
    message,
    ...meta,
  };

  // In development, pretty-print with colors
  if (process.env.NODE_ENV !== 'production' && !process.env.LOG_JSON) {
    const colorMap = {
      debug: '\x1b[90m',   // gray
      info: '\x1b[36m',    // cyan
      warn: '\x1b[33m',    // yellow
      error: '\x1b[31m',   // red
      fatal: '\x1b[35m',   // magenta
    };
    const reset = '\x1b[0m';
    const color = colorMap[level] || reset;
    const metaStr = Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    return `${color}[${entry.timestamp}] [${level.toUpperCase()}]${reset} ${message}${metaStr}`;
  }

  // Production: JSON output for log aggregation (e.g., ELK, Datadog, Loki)
  return JSON.stringify(entry);
}

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] < MIN_LEVEL) return;

  const output = formatLog(level, message, meta);

  switch (level) {
    case 'error':
    case 'fatal':
      console.error(output);
      break;
    case 'warn':
      console.warn(output);
      break;
    default:
      console.log(output);
  }

  // Track error metrics (simple in-memory counter)
  if (level === 'error' || level === 'fatal') {
    errorMetrics.increment();
  }
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  fatal: (msg, meta) => log('fatal', msg, meta),
};

// ── Error Metrics (in-memory) ────────────────────────────────────────────────

const errorMetrics = {
  totalErrors: 0,
  errorsLastHour: [],
  startTime: Date.now(),

  increment() {
    this.totalErrors++;
    const now = Date.now();
    this.errorsLastHour.push(now);
    // Prune entries older than 1 hour
    const cutoff = now - 3600000;
    this.errorsLastHour = this.errorsLastHour.filter(t => t > cutoff);
  },

  getStats() {
    return {
      total: this.totalErrors,
      lastHour: this.errorsLastHour.length,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  },
};

module.exports = { logger, errorMetrics };
