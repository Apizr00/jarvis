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

    // Try to fetch the real owner info from Telegram
    let ownerFirstName = 'Owner';
    let ownerLastName = '';
    let ownerUsername = botName;
    let ownerPhotoUrl = '';
    try {
      const axios = require('axios');
      const BASE = `https://api.telegram.org/bot${botToken}`;
      const { data: chatData } = await axios.get(`${BASE}/getChat`, {
        params: { chat_id: ownerId },
        timeout: 5000,
      });
      if (chatData?.result) {
        ownerFirstName = chatData.result.first_name || ownerFirstName;
        ownerLastName = chatData.result.last_name || '';
        ownerUsername = chatData.result.username || ownerUsername;
        // Try to get photo from getChat result
        const fileId = chatData.result.photo?.big_file_id || chatData.result.photo?.small_file_id;
        if (fileId) {
          const fileRes = await axios.get(`${BASE}/getFile`, { params: { file_id: fileId }, timeout: 5000 });
          if (fileRes.data?.result?.file_path) {
            ownerPhotoUrl = `https://api.telegram.org/file/bot${botToken}/${fileRes.data.result.file_path}`;
          }
        }
      }
    } catch {
      // Best-effort — use defaults if Telegram is unavailable
    }

    // Create JWT for the owner
    const userData = {
      id: ownerId,
      first_name: ownerFirstName,
      last_name: ownerLastName,
      username: ownerUsername,
      photo_url: ownerPhotoUrl,
      auth_date: Math.floor(Date.now() / 1000),
    };

    const jwtToken = createToken(userData);
    const user = {
      id: ownerId,
      firstName: ownerFirstName,
      lastName: ownerLastName,
      username: ownerUsername,
      photoUrl: ownerPhotoUrl,
    };

    logger.info('Token auth successful', { userId: ownerId, firstName: ownerFirstName });
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

    const axios = require('axios');
    const BASE = `https://api.telegram.org/bot${botToken}`;

    async function getPhotoUrl(userId) {
      try {
        // Try getChat first — works regardless of user's privacy settings
        // because the bot is getting info about a user it has interacted with
        const { data: chatData } = await axios.get(`${BASE}/getChat`, {
          params: { chat_id: userId },
          timeout: 8000,
        });
        const chatFileId = chatData?.result?.photo?.big_file_id || chatData?.result?.photo?.small_file_id;
        if (chatFileId) {
          const fileRes = await axios.get(`${BASE}/getFile`, { params: { file_id: chatFileId }, timeout: 8000 });
          if (fileRes.data?.result?.file_path) {
            return `https://api.telegram.org/file/bot${botToken}/${fileRes.data.result.file_path}`;
          }
        }
      } catch (e) {
        logger.warn('getChat photo failed, trying getUserProfilePhotos', { userId, error: e.message });
      }
      try {
        // Fallback: getUserProfilePhotos
        const { data } = await axios.get(`${BASE}/getUserProfilePhotos`, {
          params: { user_id: userId, limit: 1 },
          timeout: 8000,
        });
        if (data?.result?.photos?.length) {
          const fileId = data.result.photos[0][0]?.file_id;
          if (fileId) {
            const fileRes = await axios.get(`${BASE}/getFile`, { params: { file_id: fileId }, timeout: 8000 });
            if (fileRes.data?.result?.file_path) {
              return `https://api.telegram.org/file/bot${botToken}/${fileRes.data.result.file_path}`;
            }
          }
        }
      } catch (e) {
        logger.warn('getUserProfilePhotos also failed', { userId, error: e.message });
      }
      return null;
    }

    // Get bot's user ID from getMe, then fetch its profile photo using getChat
    async function getBotPhotoUrl() {
      try {
        const { data: meData } = await axios.get(`${BASE}/getMe`, { timeout: 8000 });
        const botId = meData?.result?.id;
        if (!botId) return null;
        // Use getChat to get the bot's photo (works better than getUserProfilePhotos for bots)
        const { data: chatData } = await axios.get(`${BASE}/getChat`, {
          params: { chat_id: botId },
          timeout: 8000,
        });
        const fileId = chatData?.result?.photo?.big_file_id || chatData?.result?.photo?.small_file_id;
        if (fileId) {
          const fileRes = await axios.get(`${BASE}/getFile`, { params: { file_id: fileId }, timeout: 8000 });
          if (fileRes.data?.result?.file_path) {
            return `https://api.telegram.org/file/bot${botToken}/${fileRes.data.result.file_path}`;
          }
        }
        // Fallback: try getUserProfilePhotos for the bot
        return getPhotoUrl(botId);
      } catch (e) {
        logger.warn('Failed to fetch bot photo', { error: e.message });
        return null;
      }
    }

    const [ownerPhoto, botPhoto] = await Promise.all([
      getPhotoUrl(ownerId).catch(() => null),
      getBotPhotoUrl().catch(() => null),
    ]);

    // Fallback: use photoUrl stored in JWT (set during Telegram Login Widget auth)
    const ownerPhotoFallback = (!ownerPhoto && req.user?.photoUrl) ? req.user.photoUrl : null;

    logger.info('Profile photos fetched', { hasOwner: !!(ownerPhoto || ownerPhotoFallback), hasBot: !!botPhoto, ownerId });
    res.json({ ownerPhoto: ownerPhoto || ownerPhotoFallback, botPhoto });
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
