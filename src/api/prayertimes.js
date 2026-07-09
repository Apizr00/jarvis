// src/api/prayertimes.js
// JAKIM e-Solat Prayer Times module
// Fetches from JAKIM API with production safeguards:
// - Schema validation & normalization
// - In-memory caching with TTL
// - Rate limiting
// - Error handling for empty responses, upstream failures, schema changes
// - Zone configuration

require('dotenv').config();
const axios = require('axios');
const { dayjs, fmt } = require('../utils/datetime');
const { logger } = require('../utils/logger');

// ── Configuration ───────────────────────────────────────────────────────────
const JAKIM_BASE_URL = 'https://www.e-solat.gov.my/index.php';
const DEFAULT_ZONE = process.env.PRAYER_ZONE || 'WLY01';
const CACHE_TTL_MS = parseInt(process.env.PRAYER_CACHE_TTL_MS || '300000', 10); // 5 min default
const REQUEST_TIMEOUT_MS = parseInt(process.env.PRAYER_REQUEST_TIMEOUT_MS || '10000', 10);
const MAX_RETRIES = 2;

// ── Zone reference (complete, verified against JAKIM API) ──────────────────
const ZONES = {
  // Wilayah Persekutuan
  WLY01: 'Kuala Lumpur & Putrajaya',
  WLY02: 'Labuan',
  // Selangor
  SGR01: 'Gombak, Petaling, Sepang, Hulu Langat, Hulu Selangor, S.Alam',
  SGR02: 'Kuala Selangor, Sabak Bernam',
  SGR03: 'Klang, Kuala Langat',
  // Johor
  JHR01: 'Johor Bahru, Kulai, Pontian, Kota Tinggi',
  JHR02: 'Batu Pahat, Muar, Segamat, Gemas, Tangkak, Mersing',
  JHR03: 'Kluang',
  JHR04: 'Mersing',
  // Kedah
  KDH01: 'Alor Setar, Kuala Muda, Pendang, Yan, Pokok Sena',
  KDH02: 'Langkawi',
  KDH03: 'Kulim, Bandar Baharu',
  KDH04: 'Kubang Pasu, Kota Setar',
  KDH05: 'Baling, Sik',
  KDH06: 'Gunung Jerai',
  KDH07: 'Padang Terap',
  // Kelantan
  KTN01: 'Kota Bharu, Bachok, Pasir Puteh, Tumpat, Tanah Merah, Machang, Kuala Krai',
  KTN02: 'Gua Musang',
  // Melaka
  MLK01: 'Melaka, Alor Gajah, Jasin',
  // Negeri Sembilan
  NGS01: 'Seremban, Port Dickson, Rembau, Kuala Pilah, Jelebu, Tampin',
  NGS02: 'Gemas',
  // Pahang
  PHG01: 'Kuantan, Pekan, Rompin, Maran, Bera, Temerloh, Jerantut',
  PHG02: 'Cameron Highlands, Raub, Bentong, Lipis',
  PHG03: 'Rompin',
  PHG04: 'Bera',
  PHG05: 'Jerantut',
  PHG06: 'Pekan',
  // Perak
  PRK01: 'Ipoh, Kuala Kangsar, Manjung, Perak Tengah, Hilir Perak',
  PRK02: 'Taiping, Selama, Kerian, Larut Matang',
  PRK03: 'Hulu Perak',
  PRK04: 'Batang Padang',
  PRK05: 'Muallim',
  PRK06: 'Kampar',
  PRK07: 'Bagan Datuk',
  // Perlis
  PLS01: 'Perlis',
  // Pulau Pinang
  PNG01: 'Pulau Pinang',
  // Sabah
  SBH01: 'Kota Kinabalu, Ranau, Kota Belud, Tuaran, Penampang, Papar, Putatan',
  SBH02: 'Sandakan, Tawau, Lahad Datu, Kunak, Semporna, Kinabatangan',
  SBH03: 'Kudat, Pitas',
  SBH04: 'Keningau, Tambunan, Tenom',
  SBH05: 'Beaufort, Kuala Penyu, Sipitang',
  SBH06: 'Beluran, Telupid',
  SBH07: 'Nabawan',
  SBH08: 'Pensiangan',
  SBH09: 'Tongod',
  // Sarawak
  SWK01: 'Kuching, Samarahan, Serian, Sri Aman, Betong, Sarikei',
  SWK02: 'Sibu, Mukah, Bintulu, Miri, Limbang, Kapit',
  SWK03: 'Limbang',
  SWK04: 'Miri',
  SWK05: 'Kapit',
  SWK06: 'Sarikei',
  SWK07: 'Sri Aman',
  SWK08: 'Betong',
  SWK09: 'Samarahan',
  // Terengganu
  TRG01: 'Kuala Terengganu, Marang, Hulu Terengganu, Setiu, Besut, Kemaman',
  TRG02: 'Dungun',
  TRG03: 'Kemaman',
  TRG04: 'Setiu',
};

// ── In-memory cache ─────────────────────────────────────────────────────────
const cache = {
  data: null,
  timestamp: 0,
  zone: null,
  date: null,
};

// ── Rate limiter (simple sliding window) ────────────────────────────────────
const rateLimiter = {
  windowMs: 60000,   // 1 minute window
  maxRequests: 10,    // max 10 requests per window
  hits: [],
};

function checkRateLimit() {
  const now = Date.now();
  rateLimiter.hits = rateLimiter.hits.filter(t => now - t < rateLimiter.windowMs);
  if (rateLimiter.hits.length >= rateLimiter.maxRequests) {
    return false;
  }
  rateLimiter.hits.push(now);
  return true;
}

// ── Schema: expected prayer time fields ─────────────────────────────────────
const EXPECTED_PRAYER_FIELDS = [
  'imsak', 'fajr', 'syuruk', 'dhuha', 'dhuhr', 'asr', 'maghrib', 'isha',
];

// The 5 obligatory prayer times (for notifications)
const OBLIGATORY_PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

// Friendly Malay labels
const PRAYER_LABELS = {
  imsak: 'Imsak',
  fajr: 'Subuh',
  syuruk: 'Syuruk',
  dhuha: 'Dhuha',
  dhuhr: 'Zohor',
  asr: 'Asar',
  maghrib: 'Maghrib',
  isha: 'Isyak',
};

const PRAYER_ICONS = {
  imsak: '🌙',
  fajr: '🌅',
  syuruk: '☀️',
  dhuha: '🌤️',
  dhuhr: '☀️',
  asr: '🌤️',
  maghrib: '🌇',
  isha: '🌙',
};

// ── Schema Validation & Normalization ───────────────────────────────────────

/**
 * Validate and normalize the JAKIM API response.
 * Handles schema changes, missing fields, empty responses gracefully.
 */
function validateAndNormalize(rawData) {
  if (!rawData || typeof rawData !== 'object') {
    throw new Error('Invalid API response: not an object');
  }

  // Check status
  if (rawData.status && rawData.status !== 'OK!') {
    throw new Error(`JAKIM API returned non-OK status: ${rawData.status}`);
  }

  // Check prayerTime array
  if (!Array.isArray(rawData.prayerTime) || rawData.prayerTime.length === 0) {
    throw new Error('No prayer times in response (empty prayerTime array)');
  }

  const raw = rawData.prayerTime[0];

  // Validate date field
  if (!raw.date && !raw.day) {
    throw new Error('Response missing date/day field — possible schema change');
  }

  // Normalize: ensure all expected fields exist, fill missing with null
  const normalized = {
    hijri: raw.hijri || null,
    date: raw.date || null,
    day: raw.day || null,
    timings: {},
    metadata: {
      zone: rawData.zone || DEFAULT_ZONE,
      zoneName: ZONES[rawData.zone] || rawData.zone || DEFAULT_ZONE,
      serverTime: rawData.serverTime || null,
      periodType: rawData.periodType || 'today',
      bearing: rawData.bearing || null,
      lang: rawData.lang || 'ms_my',
    },
  };

  for (const field of EXPECTED_PRAYER_FIELDS) {
    const value = raw[field];
    if (value && typeof value === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(value.trim())) {
      // Valid HH:MM:SS format
      normalized.timings[field] = value.trim();
    } else if (value) {
      // Has value but unexpected format — try to parse
      const cleaned = String(value).trim();
      const match = cleaned.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (match) {
        const hh = match[1].padStart(2, '0');
        const mm = match[2];
        const ss = match[3] || '00';
        normalized.timings[field] = `${hh}:${mm}:${ss}`;
        logger.warn('Prayer time field had unexpected format', { field, original: value, normalized: normalized.timings[field] });
      } else {
        normalized.timings[field] = null;
        logger.warn('Prayer time field could not be parsed', { field, value });
      }
    } else {
      // Missing field entirely — schema may have changed
      normalized.timings[field] = null;
      logger.warn('Prayer time field missing from API response', { field });
    }
  }

  // Warn if any obligatory prayer is missing
  for (const prayer of OBLIGATORY_PRAYERS) {
    if (!normalized.timings[prayer]) {
      logger.error('Obligatory prayer time missing!', { prayer, zone: normalized.metadata.zone });
    }
  }

  return normalized;
}

// ── API Fetch ────────────────────────────────────────────────────────────────

/**
 * Fetch prayer times from JAKIM API with retry logic.
 * @param {string} zone - Zone code (e.g., 'WLY01')
 * @param {string} period - 'today', 'week', 'month'
 * @returns {Promise<object>} Normalized prayer times data
 */
async function fetchFromJakim(zone = DEFAULT_ZONE, period = 'today') {
  const url = `${JAKIM_BASE_URL}?r=esolatApi/takwimsolat&period=${period}&zone=${zone}`;

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info('Fetching prayer times from JAKIM', { zone, period, attempt });

      const response = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Jarvis-PersonalAssistant/3.0',
        },
        // Validate response is JSON
        responseType: 'json',
        // Don't throw on non-2xx — we handle it
        validateStatus: status => status < 500,
      });

      // Check for non-200 responses
      if (response.status !== 200) {
        throw new Error(`JAKIM API returned HTTP ${response.status}`);
      }

      // Validate and normalize
      const data = validateAndNormalize(response.data);

      // Update cache
      cache.data = data;
      cache.timestamp = Date.now();
      cache.zone = zone;
      cache.date = data.date;

      logger.info('Prayer times fetched successfully', {
        zone,
        date: data.date,
        hijri: data.hijri,
        prayersFound: Object.values(data.timings).filter(Boolean).length,
      });

      return data;

    } catch (err) {
      lastError = err;

      // Don't retry on validation errors (the data itself is bad)
      if (err.message.includes('Invalid API response') ||
        err.message.includes('No prayer times') ||
        err.message.includes('missing date/day')) {
        logger.error('JAKIM API response validation failed — not retrying', {
          error: err.message,
          zone,
        });
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 1000; // exponential backoff
        logger.warn('JAKIM API fetch failed, retrying', {
          attempt,
          delay,
          error: err.message,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted
  logger.error('JAKIM API fetch failed after all retries', {
    zone,
    retries: MAX_RETRIES,
    error: lastError?.message,
  });

  // If we have stale cache, serve it with a warning
  if (cache.data && cache.zone === zone) {
    logger.warn('Serving stale cached prayer times', {
      cacheAge: Date.now() - cache.timestamp,
      date: cache.date,
    });
    return {
      ...cache.data,
      _stale: true,
      _cacheAge: Date.now() - cache.timestamp,
    };
  }

  throw new Error(`Failed to fetch prayer times for ${zone}: ${lastError?.message}`);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get prayer times with caching.
 * Returns cached data if within TTL, otherwise fetches fresh.
 */
async function getPrayerTimes(zone = DEFAULT_ZONE, forceRefresh = false) {
  // Check rate limit
  if (!checkRateLimit() && !forceRefresh) {
    logger.warn('Rate limit hit for prayer times', { zone });
    if (cache.data && cache.zone === zone) {
      return { ...cache.data, _rateLimited: true };
    }
    throw new Error('Rate limit exceeded. Please try again later.');
  }

  // Check cache
  const now = Date.now();
  if (
    !forceRefresh &&
    cache.data &&
    cache.zone === zone &&
    cache.date === dayjs().tz('Asia/Kuala_Lumpur').format('DD-MMM-YYYY') &&
    now - cache.timestamp < CACHE_TTL_MS
  ) {
    return {
      ...cache.data,
      _cached: true,
      _cacheAge: now - cache.timestamp,
    };
  }

  return fetchFromJakim(zone);
}

/**
 * Get only the 5 obligatory prayer times for notification scheduling.
 */
function getObligatoryTimings(timings) {
  const result = {};
  for (const key of OBLIGATORY_PRAYERS) {
    if (timings[key]) {
      result[key] = timings[key];
    }
  }
  return result;
}

/**
 * Get prayer times formatted for notifications.
 */
function formatPrayerNotification(prayerKey, timeStr, zoneName) {
  const label = PRAYER_LABELS[prayerKey] || prayerKey;
  const icon = PRAYER_ICONS[prayerKey] || '🕌';
  const time12h = dayjs(`2000-01-01 ${timeStr}`).format('hh:mm A');
  return `${icon} *${label}* — ${time12h}\n📍 ${zoneName}`;
}

/**
 * Invalidate the cache (useful for testing or manual refresh).
 */
function invalidateCache() {
  cache.data = null;
  cache.timestamp = 0;
  cache.zone = null;
  cache.date = null;
  logger.info('Prayer times cache invalidated');
}

module.exports = {
  getPrayerTimes,
  fetchFromJakim,
  getObligatoryTimings,
  formatPrayerNotification,
  invalidateCache,
  validateAndNormalize,
  ZONES,
  DEFAULT_ZONE,
  OBLIGATORY_PRAYERS,
  PRAYER_LABELS,
  PRAYER_ICONS,
  EXPECTED_PRAYER_FIELDS,
};
