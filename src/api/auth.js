// src/api/auth.js
// ── Telegram Login Verification + JWT Auth ─────────────────────────────────
//
// Flow:
//   1. User clicks Telegram Login Widget on frontend
//   2. Telegram sends user data + hash to our callback
//   3. POST /api/auth/telegram — verify hash with bot token, issue JWT
//   4. GET  /api/auth/me      — returns current user from JWT
//   5. All protected routes use `requireAuth` middleware
//
// Telegram Login Widget spec:
//   https://core.telegram.org/widgets/login#receiving-authorization-data

const crypto = require('crypto');
const { logger } = require('../utils/logger');

// ── JWT ──────────────────────────────────────────────────────────────────────
let jwt = null;
try {
  jwt = require('jsonwebtoken');
} catch {
  // jsonwebtoken is an optional dep; fall back to a simple signed token
  logger.warn('jsonwebtoken not installed — using fallback signed token');
}

const JWT_EXPIRY = '7d';
const JWT_SECRET = process.env.JWT_SECRET || process.env.TELEGRAM_BOT_TOKEN || 'jarvis-playground-secret';

// ── Telegram Hash Verification ───────────────────────────────────────────────

/**
 * Verify the hash from Telegram Login Widget.
 * The hash is SHA-256 of sorted key=value pairs, with bot token as secret.
 *
 * @param {object} data — { id, first_name, last_name?, username?, photo_url?, auth_date, hash }
 * @param {string} botToken
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyTelegramHash(data, botToken) {
  const { hash, ...fields } = data;

  if (!hash) {
    return { valid: false, reason: 'Missing hash field' };
  }

  // Sort keys alphabetically, build check string: key=value\n...
  const checkString = Object.keys(fields)
    .sort()
    .map(k => `${k}=${fields[k]}`)
    .join('\n');

  // Create SHA-256 HMAC using bot token as secret
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  if (computedHash !== hash) {
    return { valid: false, reason: 'Hash mismatch — invalid or expired login data' };
  }

  // Check auth_date is not too old (within 24 hours)
  const authDate = parseInt(fields.auth_date, 10);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return { valid: false, reason: 'Login data expired (>24h old)' };
  }

  return { valid: true };
}

// ── JWT Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a JWT for a verified Telegram user.
 */
function createToken(user) {
  const payload = {
    sub: String(user.id),
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    username: user.username || '',
    photoUrl: user.photo_url || '',
    iat: Math.floor(Date.now() / 1000),
  };

  if (jwt) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  }

  // Fallback: simple base64-encoded JSON with HMAC signature
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * Verify a JWT and return the payload, or null.
 */
function verifyToken(token) {
  if (!token) return null;

  try {
    if (jwt) {
      return jwt.verify(token, JWT_SECRET);
    }

    // Fallback verification
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, bodyB64, sigB64] = parts;
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${bodyB64}`)
      .digest('base64url');

    if (expectedSig !== sigB64) return null;

    const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));

    // Check expiry
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Express Middleware ───────────────────────────────────────────────────────

/**
 * Express middleware: require valid JWT in Authorization header.
 * Populates req.user on success.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <token>' });
  }

  const token = authHeader.slice(7);
  const user = verifyToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Only allow the configured owner
  const ownerId = String(process.env.TELEGRAM_OWNER_ID);
  if (user.sub !== ownerId) {
    return res.status(403).json({ error: 'Forbidden — not the configured owner' });
  }

  req.user = user;
  next();
}

/**
 * Express middleware: optional auth — sets req.user if token is valid, continues either way.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const user = verifyToken(token);
    if (user) req.user = user;
  }
  next();
}

// ── Route Handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/auth/telegram
 * Body: { id, first_name, last_name?, username?, photo_url?, auth_date, hash }
 * Returns: { token, user }
 */
async function telegramAuthHandler(req, res) {
  try {
    const data = req.body;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured on server' });
    }

    if (!data.id || !data.auth_date || !data.hash) {
      return res.status(400).json({
        error: 'Missing required fields: id, auth_date, hash',
        received: Object.keys(data),
      });
    }

    // Verify the Telegram hash
    const result = verifyTelegramHash(data, botToken);
    if (!result.valid) {
      logger.warn('Telegram auth failed', { reason: result.reason, userId: data.id });
      return res.status(401).json({ error: result.reason });
    }

    // Check if this is the configured owner
    const ownerId = String(process.env.TELEGRAM_OWNER_ID);
    if (String(data.id) !== ownerId) {
      logger.warn('Telegram auth: not owner', { userId: data.id, ownerId });
      return res.status(403).json({ error: 'This playground is private. Only the bot owner can log in.' });
    }

    // Create JWT
    const token = createToken(data);
    const user = {
      id: String(data.id),
      firstName: data.first_name || '',
      lastName: data.last_name || '',
      username: data.username || '',
      photoUrl: data.photo_url || '',
    };

    logger.info('Telegram auth successful', { userId: data.id, username: data.username });

    res.json({ token, user });
  } catch (err) {
    logger.error('Telegram auth handler error', { error: err.message });
    res.status(500).json({ error: 'Internal auth error' });
  }
}

/**
 * POST /api/auth/token
 * Simple token-based login — accepts the raw bot token, compares to server.
 * Body: { token }
 * Returns: { token, user }
 */
async function tokenAuthHandler(req, res) {
  try {
    const { token: userToken } = req.body;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured on server' });
    }

    if (!userToken || typeof userToken !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "token" field in request body' });
    }

    // Compare tokens
    if (userToken.trim() !== botToken.trim()) {
      logger.warn('Token auth failed — token mismatch');
      return res.status(401).json({ error: 'Invalid token. Use the correct Telegram bot token from @BotFather.' });
    }

    // Get owner info from env
    const ownerId = String(process.env.TELEGRAM_OWNER_ID);
    const botName = process.env.BOT_NAME || 'Jarvis';

    // Create JWT for the owner
    const userData = {
      id: ownerId,
      first_name: 'Owner',
      username: botName,
      photo_url: '',
      auth_date: Math.floor(Date.now() / 1000),
    };

    const jwtToken = createToken(userData);
    const user = {
      id: ownerId,
      firstName: 'Owner',
      lastName: '',
      username: botName,
      photoUrl: '',
    };

    logger.info('Token auth successful', { userId: ownerId });
    res.json({ token: jwtToken, user });
  } catch (err) {
    logger.error('Token auth handler error', { error: err.message });
    res.status(500).json({ error: 'Internal auth error' });
  }
}

/**
 * GET /api/auth/me
 * Returns the current authenticated user from JWT.
 */
function meHandler(req, res) {
  res.json({ user: req.user });
}

// ── Profile Photos ──────────────────────────────────────────────────────────

/**
 * GET /api/auth/photos
 * Returns owner and bot profile photo URLs fetched from Telegram API.
 */
async function photosHandler(req, res) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const ownerId = process.env.TELEGRAM_OWNER_ID;
    if (!botToken || !ownerId) {
      return res.json({ ownerPhoto: null, botPhoto: null });
    }

    const https = require('https');
    const fetchTel = (method, params) => new Promise((resolve) => {
      const qs = new URLSearchParams(params).toString();
      https.get(`https://api.telegram.org/bot${botToken}/${method}?${qs}`, (resp) => {
        let data = '';
        resp.on('data', (c) => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    // Fetch owner photos
    const ownerPhotos = await fetchTel('getUserProfilePhotos', { user_id: ownerId, limit: 1 });
    let ownerPhoto = null;
    if (ownerPhotos?.result?.photos?.length) {
      const fileId = ownerPhotos.result.photos[0][0]?.file_id;
      const fileInfo = await fetchTel('getFile', { file_id: fileId });
      if (fileInfo?.result?.file_path) {
        ownerPhoto = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
      }
    }

    // Fetch bot photo
    const botInfo = await fetchTel('getMe', {});
    let botPhoto = null;
    if (botInfo?.result?.id) {
      const botPhotos = await fetchTel('getUserProfilePhotos', { user_id: botInfo.result.id, limit: 1 });
      if (botPhotos?.result?.photos?.length) {
        const fileId = botPhotos.result.photos[0][0]?.file_id;
        const fileInfo = await fetchTel('getFile', { file_id: fileId });
        if (fileInfo?.result?.file_path) {
          botPhoto = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
        }
      }
    }

    res.json({ ownerPhoto, botPhoto });
  } catch (err) {
    logger.error('Photos fetch error', { error: err.message });
    res.json({ ownerPhoto: null, botPhoto: null });
  }
}

// ── WebSocket Auth ───────────────────────────────────────────────────────────

/**
 * Authenticate a WebSocket connection from URL query params.
 * Expects: ws://host/ws?token=xxx
 *
 * @param {URL} url — parsed URL of the upgrade request
 * @returns {{ user: object|null, error: string|null }}
 */
function authenticateWebSocket(url) {
  const token = url.searchParams.get('token');
  if (!token) {
    return { user: null, error: 'Missing token query parameter' };
  }

  const user = verifyToken(token);
  if (!user) {
    return { user: null, error: 'Invalid or expired token' };
  }

  const ownerId = String(process.env.TELEGRAM_OWNER_ID);
  if (user.sub !== ownerId) {
    return { user: null, error: 'Forbidden — not the configured owner' };
  }

  return { user, error: null };
}

module.exports = {
  requireAuth,
  optionalAuth,
  telegramAuthHandler,
  tokenAuthHandler,
  meHandler,
  photosHandler,
  authenticateWebSocket,
  createToken,
  verifyToken,
  verifyTelegramHash,
};
