// src/api/status.js
// API connectivity status checker
require('dotenv').config();
const axios = require('axios');

/**
 * Check if an API endpoint is reachable with a quick request.
 * Returns true if we get any response (including auth errors, which prove the server is up).
 */
async function checkEndpoint(url, headers, timeout = 5000) {
  try {
    await axios.get(url, { headers, timeout });
    return true;
  } catch (err) {
    // 401/403/404 means we reached the server — still "connected"
    if (err.response && err.response.status >= 400 && err.response.status < 500) {
      return true;
    }
    return false;
  }
}

/**
 * Ping an OpenAI-compatible chat API by sending a minimal POST.
 * Some smaller providers don't expose GET /v1/models but do respond to chat completions.
 */
async function checkChatEndpoint(url, apiKey, timeout = 5000) {
  try {
    await axios.post(url,
      { model: 'ping', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
      { headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, timeout }
    );
    return true;
  } catch (err) {
    // Any HTTP response (including 4xx) means the server is reachable
    if (err.response) return true;
    return false;
  }
}

/**
 * Get the status of all APIs used by Jarvis.
 * @param {object} [bot] - node-telegram-bot-api instance (optional, for Telegram check)
 * @returns {Promise<Array<{name:string, configured:boolean, connected:boolean|null, detail:string}>>}
 */
async function getApiStatus(bot) {
  const results = [];

  // ── Telegram Bot API ─────────────────────────────────────────────────────
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  let tgConnected = null;
  if (tgToken && bot) {
    try {
      const me = await bot.getMe();
      tgConnected = !!me;
    } catch {
      tgConnected = false;
    }
  } else if (tgToken) {
    // No bot instance — just check if token is set
    tgConnected = null;
  }
  results.push({
    name: 'Telegram Bot',
    icon: '✈️',
    configured: !!tgToken,
    connected: tgConnected,
    detail: tgToken ? 'Token set' : 'TELEGRAM_BOT_TOKEN missing',
  });

  // ── DeepSeek (Primary LLM) ───────────────────────────────────────────────
  const dsKey = process.env.DEEPSEEK_API_KEY;
  let dsConnected = null;
  if (dsKey) {
    dsConnected = await checkEndpoint(
      (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/v1/models',
      { Authorization: 'Bearer ' + dsKey }
    );
  }
  results.push({
    name: 'DeepSeek (LLM)',
    icon: '🐳',
    configured: !!dsKey,
    connected: dsConnected,
    detail: dsKey ? 'DEEPSEEK_API_KEY set' : 'DEEPSEEK_API_KEY missing',
  });

  // ── MiMo (Backup LLM) ────────────────────────────────────────────────────
  const mimoKey = process.env.MIMO_API_KEY;
  let mimoConnected = null;
  if (mimoKey) {
    const mimoBase = (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
    const mimoUrl = mimoBase.endsWith('/v1')
      ? mimoBase + '/chat/completions'
      : mimoBase + '/v1/chat/completions';
    mimoConnected = await checkChatEndpoint(mimoUrl, mimoKey);
  }
  results.push({
    name: 'MiMo (Backup LLM)',
    icon: '🤖',
    configured: !!mimoKey,
    connected: mimoConnected,
    detail: mimoKey ? 'MIMO_API_KEY set' : 'MIMO_API_KEY missing',
  });

  // ── OpenAI Whisper (Voice) ────────────────────────────────────────────────
  const oaKey = process.env.OPENAI_API_KEY;
  let oaConnected = null;
  if (oaKey) {
    oaConnected = await checkEndpoint(
      'https://api.openai.com/v1/models',
      { Authorization: 'Bearer ' + oaKey }
    );
  }
  results.push({
    name: 'OpenAI Whisper (Voice)',
    icon: '🎙️',
    configured: !!oaKey,
    connected: oaConnected,
    detail: oaKey ? 'OPENAI_API_KEY set' : 'OPENAI_API_KEY missing',
  });

  // ── Tavily Search ─────────────────────────────────────────────────────────
  const tvKey = process.env.TAVILY_API_KEY;
  let tvConnected = null;
  if (tvKey) {
    tvConnected = await checkEndpoint(
      'https://api.tavily.com/search',
      { Authorization: 'Bearer ' + tvKey }
    );
  }
  results.push({
    name: 'Tavily (Web Search)',
    icon: '🔍',
    configured: !!tvKey,
    connected: tvConnected,
    detail: tvKey ? 'TAVILY_API_KEY set' : 'TAVILY_API_KEY missing',
  });

  // ── Redis ────────────────────────────────────────────────────────────────
  let redisConnected = null;
  try {
    const redis = require('../redis');
    if (redis && redis.redis) {
      try {
        await redis.redis.ping();
        redisConnected = true;
      } catch {
        redisConnected = false;
      }
    }
  } catch {
    redisConnected = null;
  }
  results.push({
    name: 'Redis Cache',
    icon: '🗄️',
    configured: !!process.env.REDIS_URL,
    connected: redisConnected,
    detail: process.env.REDIS_URL ? 'REDIS_URL set' : 'REDIS_URL not set (optional)',
  });

  return results;
}

/**
 * Format API status results into a Markdown message for Telegram.
 * @param {Array} statuses - from getApiStatus()
 * @returns {string}
 */
function formatStatusMessage(statuses) {
  let msg = '*🔌 Jarvis API Status*\n\n';

  for (const s of statuses) {
    const icon = s.icon || '•';
    const connIcon = s.connected === true ? '✅' : s.connected === false ? '❌' : '⚪';
    const connLabel = s.connected !== null
      ? (s.connected ? 'Connected' : 'Unreachable')
      : (s.configured ? 'Untested' : 'N/A');

    msg += icon + ' *' + s.name + '*\n';
    msg += '  └ ' + connIcon + ' ' + connLabel;
    if (s.connected === false && s.configured) {
      msg += ' — check network or API endpoint';
    }
    msg += '\n';
  }

  msg += '\n_✅ Reachable | ❌ Unreachable | ⚪ Not tested_';
  return msg;
}

module.exports = { getApiStatus, formatStatusMessage };
