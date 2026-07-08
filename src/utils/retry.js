// src/utils/retry.js
// Retry mechanism dengan exponential backoff
// Digunakan untuk DB queries dan external API calls yang gagal sementara.
//
// Contoh:
//   const result = await withRetry(() => db.query('SELECT ...'), { maxRetries: 3 });

const { logger } = require('./logger');

/**
 * Execute an async function with automatic retry on transient errors.
 *
 * @param {Function} fn - async function to execute
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3] - maximum retry attempts
 * @param {number} [options.baseDelayMs=200] - initial delay before first retry
 * @param {number} [options.maxDelayMs=5000] - maximum delay cap
 * @param {Function} [options.shouldRetry] - custom predicate: (error, attempt) => boolean
 * @param {string} [options.name='operation'] - label for logging
 * @returns {Promise<any>} result of fn()
 */
async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 200,
    maxDelayMs = 5000,
    shouldRetry = defaultShouldRetry,
    name = 'operation',
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry if it's a permanent error
      if (!shouldRetry(err, attempt)) {
        throw err;
      }

      // Don't retry if we've exhausted attempts
      if (attempt > maxRetries) {
        logger.error(`[Retry] ${name} gagal selepas ${maxRetries} percubaan: ${err.message}`, {
          attempts: attempt,
          errorCode: err.code,
        });
        throw err;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100,
        maxDelayMs
      );

      logger.warn(`[Retry] ${name} percubaan ${attempt}/${maxRetries} gagal — mencuba lagi dalam ${Math.round(delay)}ms: ${err.message}`, {
        attempts: attempt,
        delayMs: Math.round(delay),
        errorCode: err.code,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Default retry predicate — checks for common transient error codes.
 */
function defaultShouldRetry(error, attempt) {
  // PostgreSQL transient errors
  const pgTransientCodes = [
    '40001', // serialization failure
    '40P01', // deadlock detected
    '08006', // connection failure
    '08001', // unable to connect
    '57P01', // admin shutdown
    '57P02', // crash shutdown
    '57P03', // cannot connect now
    '53300', // too many connections
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
  ];

  if (error.code && pgTransientCodes.includes(error.code)) {
    return true;
  }

  // Network errors (axios)
  if (error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK') {
    return true;
  }

  // HTTP 429 Too Many Requests or 5xx Server Errors
  if (error.response) {
    const status = error.response.status;
    if (status === 429 || status >= 500) {
      return true;
    }
  }

  // Unknown/generic errors on first attempt
  if (attempt === 1 && !error.code) {
    return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a retry-wrapped version of a database pool query function.
 * Returns a function with the same signature as pool.query().
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @returns {Function} retry-wrapped query function
 */
function createRetryableQuery(pool) {
  return async function retryableQuery(text, params) {
    return withRetry(
      () => pool.query(text, params),
      {
        maxRetries: 3,
        baseDelayMs: 200,
        name: 'DB: ' + (typeof text === 'string' ? text.substring(0, 40).replace(/\n/g, ' ') : 'query'),
      }
    );
  };
}

module.exports = { withRetry, createRetryableQuery, sleep };
