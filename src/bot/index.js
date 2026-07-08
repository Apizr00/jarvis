// src/bot/index.js
// Telegram bot - handles all incoming messages
require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const { dayjs, fmt } = require('../utils/datetime');
const db = require('../db');
const llm = require('../llm');
const tools = require('../tools');
const { escapeMd, safeSendMessage } = tools;
const { getPendingConfig, confirmPendingConfig, removePendingConfig, setPendingConfig } = tools;
const { buildBriefingMessage } = require('../scheduler');
const { getQuote } = require('../tools/quote');
let { refreshSchedules } = require('../scheduler');
const { transcribe, downloadVoiceFile } = require('../llm/whisper');
const { getApiStatus, formatStatusMessage } = require('../api/status');
const { formatFeaturesMarkdown } = require('../api/features');
const memory = require('../memory');
const relationships = require('../memory/relationships');
const domains = require('../memory/domains');
const patterns = require('../patterns');
const executive = require('../executive');
const stateMachine = require('../executive/state-machine');
const lifecycle = require('../executive/lifecycle');
const trace = require('../utils/trace');
const { invalidateConfigCache } = require('../llm/shared');
const { eventBus, EVENTS } = require('../events');
const { pluginRegistry } = require('../plugins');
const { agentRegistry } = require('../agents');

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);

// ── Greeting hallucination guard ──────────────────────────────────────────────
// LLMs often default to "Selamat pagi" regardless of actual time.
// This function detects and fixes wrong time-of-day greetings in the bot's reply.
function fixHallucinatedGreeting(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  // ⚡ Early exit: skip if no greeting keywords
  if (!/(selamat\s*(pagi|petang|malam|tengah\s*hari))/i.test(text)) return text;

  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();
  const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);

  // Determine the correct time period
  let correctPeriod;
  if (hour >= 5 && hour < 12) {
    correctPeriod = 'pagi';
  } else if (hour >= 12 && hour < 14) {
    correctPeriod = 'tengah hari';
  } else if (hour >= 14 && hour < 19) {
    correctPeriod = 'petang';
  } else {
    correctPeriod = 'malam';
  }

  // Patterns for each greeting, with the opening "Selamat X" pattern
  // We only fix the OPENING greeting (start of message or after punctuation/newline)
  // "Selamat malam" as farewell at end of message is NOT replaced
  const greetingPatterns = [
    { pattern: /\b(Selamat\s+pagi)\b/gi, period: 'pagi' },
    { pattern: /\b(Selamat\s+tengah\s+hari)\b/gi, period: 'tengah hari' },
    { pattern: /\b(Selamat\s+petang)\b/gi, period: 'petang' },
    { pattern: /(?<!\bbye\b|\bgoodbye\b|\bbai\b|\bjumpa\b|\bnight\b)\s*(Selamat\s+malam)\b(?!\s*(?:lah|je|aja|semua|semuanya|dunia|sayang|sayangku))/gi, period: 'malam' },
  ];

  const replacements = [];

  for (const { pattern, period } of greetingPatterns) {
    if (period === correctPeriod) continue; // already correct, skip

    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      // For "selamat malam", only fix if it's used as an opening greeting
      // (near the start of the message), not as a farewell
      if (period === 'malam') {
        // Check if this looks like a farewell context — skip if so
        const afterMatch = text.substring(match.index + match[0].length, match.index + match[0].length + 30);
        if (/(?:jumpa|bye|goodbye|bai|tidur|sleep|good\s*night)/i.test(afterMatch)) continue;
        // Also check if it's very late in the message (farewell tends to be at end)
        const positionRatio = match.index / text.length;
        if (positionRatio > 0.7) continue; // likely a farewell, not opening greeting
      }

      const correctGreeting = 'Selamat ' + correctPeriod;
      replacements.push({ index: match.index, oldStr: match[1], newStr: correctGreeting });
      console.log('[Bot] 👋 Fixing hallucinated greeting: "' + match[1] + '" → "' + correctGreeting + '" (hour=' + hour + ', period=' + correctPeriod + ')');
    }
  }

  if (replacements.length === 0) return text;

  // Sort by index descending for right-to-left replacement
  replacements.sort((a, b) => b.index - a.index);

  let fixed = text;
  for (const r of replacements) {
    const before = fixed.substring(0, r.index);
    const after = fixed.substring(r.index + r.oldStr.length);
    fixed = before + r.newStr + after;
  }

  return fixed;
}

// ── Time hallucination guard ────────────────────────────────────────────────
// LLMs love to make up times. This function scans the bot's reply for any
// time mention that doesn't match the actual current time, and fixes it.
// Supports Malay ("pukul 6:50", "jam 6.50") and English ("6:50 am", "6.50pm").
function fixHallucinatedTime(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  // ⚡ Early exit: skip if no digits or time keywords — avoids expensive regex
  if (!/\d/.test(text)) return text;
  if (!/(pukul|jam|[.:]\d|pagi|petang|malam|am|pm|tengah)/i.test(text)) return text;

  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();

  // Get current hour and minute in configured timezone
  const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
  const minute = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, minute: '2-digit' }).format(now), 10);
  const actualTotalMins = hour * 60 + minute;

  // Pattern: optional time-word prefix + HH:MM or HH.MM + optional AM/PM/suffix
  const timePattern = /(pukul|jam|dah\s+(?:pukul|jam)\s+|around\s+|about\s+|at\s+|it'?s?\s+|is\s+|now\s+|already\s+)?(\d{1,2})[:.](\d{2})(?!\d)\s*(pagi|am|a\.m\.?|petang|malam|pm|p\.m\.?)?/gi;

  // Collect all replacements (index, oldStr, newStr) to apply from right to left
  const replacements = [];

  let match;
  while ((match = timePattern.exec(text)) !== null) {
    const fullMatch = match[0];
    const prefix = (match[1] || '');
    const matchedHour = parseInt(match[2], 10);
    const matchedMinute = parseInt(match[3], 10);
    const period = (match[4] || '').toLowerCase();

    // Convert to 24h for comparison
    let matched24h = matchedHour;
    if (/(petang|malam|pm|p\.m)/i.test(period)) {
      if (matchedHour !== 12) matched24h = matchedHour + 12;
    } else if (/(pagi|am|a\.m)/i.test(period)) {
      if (matchedHour === 12) matched24h = 0;
    }

    const matchedTotalMins = matched24h * 60 + matchedMinute;
    const diffMins = Math.abs(matchedTotalMins - actualTotalMins);

    // Only fix if > 2 minutes off
    if (diffMins <= 2) continue;

    // ── Guard: only fix times that are clearly meant to be CURRENT time ──
    // Future/past references like "remind at 12:30", "nanti pukul 6",
    // "tadi pukul 3" should NOT be replaced with the current time.
    // We check the prefix (captured by the regex) and surrounding context.
    const prefixLower = prefix.toLowerCase();
    const isCurrentTimeContext =
      /^(dah\s+)?(pukul|jam)\s*$/i.test(prefix) ||   // "dah pukul X", "pukul X" (bare)
      /\b(now|sekarang|it'?s?\s+now|currently|masa\s+sekarang)\b/i.test(prefix) ||
      /^(it'?s?|is|now|already)\s*$/i.test(prefix);    // "it's X", "is X", "now X"

    // Future-reference prefixes: "at X", "nanti pukul X", "remind at X"
    const isFutureContext =
      /\b(at|nanti|remind|akan|pada|around|about|by|before|until|hingga|sampai|dalam|lagi|next|esok|tomorrow|lusa|minggu|bulan)\b/i.test(prefixLower) ||
      /\b(?:ingatkan|remind(?:er)?|event|jadual|schedule|meeting)\b/i.test(fullMatch);

    // Past-reference prefixes
    const isPastContext =
      /\b(tadi|was|earlier|semalam|kelmarin|yesterday|last)\b/i.test(prefixLower);

    // Skip replacement if this time is clearly a future/past reference
    if (isFutureContext || isPastContext) {
      console.log('[Bot] ⏰ Skipping time fix — looks like future/past reference: "' + fullMatch + '" (diff=' + diffMins + 'min)');
      continue;
    }

    // Only fix if it's likely a current-time hallucination (bare "pukul X" or similar)
    if (!isCurrentTimeContext) {
      // For ambiguous cases (no clear prefix), check broader context around this match
      const before = text.substring(Math.max(0, match.index - 40), match.index);
      if (/(?:nanti|akan|remind|ingatkan|at\s*$|pada\s*$|esok|tomorrow)/i.test(before)) {
        console.log('[Bot] ⏰ Skipping time fix — broader context suggests future reference: "' + fullMatch + '"');
        continue;
      }
      if (/(?:tadi|was|semalam|yesterday)/i.test(before)) {
        console.log('[Bot] ⏰ Skipping time fix — broader context suggests past reference: "' + fullMatch + '"');
        continue;
      }
    }

    // Format the correct time
    const correctHour12 = hour % 12 === 0 ? 12 : hour % 12;
    const correctMinStr = minute.toString().padStart(2, '0');
    const separator = fullMatch.includes(':') ? ':' : '.';

    // Preserve original format as much as possible
    let replacement = prefix + correctHour12 + separator + correctMinStr;
    if (period) replacement += ' ' + period;

    replacements.push({ index: match.index, oldStr: fullMatch, newStr: replacement });
  }

  // Also check "tengah hari" / "tengah malam" mentions
  const tengahHariRe = /\btengah\s*hari\b/gi;
  const tengahMalamRe = /\btengah\s*malam\b/gi;
  const isNoon = hour === 12;
  const isMidnight = hour === 0;

  if (!isNoon) {
    while ((match = tengahHariRe.exec(text)) !== null) {
      const correctTime = 'pukul ' + hour + ':' + minute.toString().padStart(2, '0');
      replacements.push({ index: match.index, oldStr: match[0], newStr: correctTime });
    }
  }
  if (!isMidnight) {
    while ((match = tengahMalamRe.exec(text)) !== null) {
      const correctTime = 'pukul ' + hour + ':' + minute.toString().padStart(2, '0');
      replacements.push({ index: match.index, oldStr: match[0], newStr: correctTime });
    }
  }

  // ── Relative time hallucination: "dalam X minit" / "X minit lagi" near current time ──
  // If text mentions the current time AND says "dalam 5 minit", but it's actually now,
  // the relative phrase is hallucinated. Replace with "sekarang" / "now".
  const relativePattern = /(?:dalam|tinggal|lagi)\s+(\d+)\s*(?:minit|minute|min|minit\s+lagi|minutes?\s+(?:left|from\s+now))/gi;
  const hasCurrentTimeMention = (() => {
    const currentMinStr = minute.toString().padStart(2, '0');
    const hr12 = hour % 12 === 0 ? 12 : hour % 12;
    return text.includes(hr12 + ':' + currentMinStr) || text.includes(hr12 + '.' + currentMinStr);
  })();

  if (hasCurrentTimeMention) {
    let relMatch;
    relativePattern.lastIndex = 0;
    while ((relMatch = relativePattern.exec(text)) !== null) {
      const minsOff = parseInt(relMatch[1], 10);
      if (minsOff >= 3) {
        console.log('[Bot] ⏰ Suspicious relative time: "' + relMatch[0] + '" near current time mention — may be hallucinated');
        // Replace relative phrase with "sekarang"
        replacements.push({
          index: relMatch.index,
          oldStr: relMatch[0],
          newStr: /\bminit\b/i.test(relMatch[0]) ? 'sekarang' : 'now',
        });
      }
    }
  }

  if (replacements.length === 0) return text;

  // Sort by index descending so we can replace from right to left
  replacements.sort((a, b) => b.index - a.index);

  let fixed = text;
  for (const r of replacements) {
    const before = fixed.substring(0, r.index);
    const after = fixed.substring(r.index + r.oldStr.length);
    fixed = before + r.newStr + after;
    console.log('[Bot] ⏰ Fixing hallucinated time: "' + r.oldStr + '" → "' + r.newStr + '" (actual=' + hour + ':' + minute.toString().padStart(2, '0') + ')');
  }

  console.log('[Bot] ⏰ Corrected message:', fixed.slice(0, 200));
  return fixed;
}

// Simple in-memory conversation history per user (last 10 turns)
// Populated from DB on startup, kept in sync with DB on every message
const conversationHistory = {};

/**
 * Load recent chat history from DB into in-memory cache.
 * Called once at bot startup to restore context.
 */
async function loadHistoryFromDB(userId) {
  try {
    const rows = await db.getRecentChatHistory(userId, 20);
    if (rows.length > 0) {
      conversationHistory[userId] = rows;
      console.log('[Bot] 📜 Loaded ' + rows.length + ' history messages from DB for user ' + userId);
    }
  } catch (err) {
    console.warn('[Bot] Could not load chat history from DB:', err.message);
  }
}

// Track which item the user is currently editing (set by inline button click)
// Format: { userId: { type: 'reminder'|'event', id: number, label: string, timestamp: number } }
const pendingEdits = {};

function setPendingEdit(userId, type, id, label) {
  pendingEdits[userId] = { type, id, label, timestamp: Date.now() };
  // Auto-expire after 2 minutes
  setTimeout(() => {
    const current = pendingEdits[userId];
    if (current && current.timestamp === pendingEdits[userId]?.timestamp) {
      delete pendingEdits[userId];
    }
  }, 2 * 60 * 1000);
}

function getPendingEdit(userId) {
  const edit = pendingEdits[userId];
  if (!edit) return null;
  if (Date.now() - edit.timestamp > 2 * 60 * 1000) {
    delete pendingEdits[userId];
    return null;
  }
  return edit;
}

function clearPendingEdit(userId) {
  delete pendingEdits[userId];
}

function getHistory(userId) {
  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  return conversationHistory[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  // Keep last 20 messages (doubled from 10 — prevents context loss in deep conversations)
  if (history.length > 20) history.splice(0, history.length - 20);

  // 💾 Persist to DB (fire-and-forget — don't block the response)
  db.saveChatMessage(userId, role, content).catch(err => {
    console.warn('[Bot] Failed to persist chat message:', err.message);
  });
}

function clearHistory(userId) {
  delete conversationHistory[userId];
  console.log('[Bot] 🧹 Cleared conversation history for ' + userId);
}

// ── Conversation Summarization (prevents context amnesia) ──────────────────
// When history exceeds 15 messages, compress older messages into a topic
// summary so the LLM retains awareness of earlier conversation without
// blowing through token limits. The last 12 messages are always preserved
// verbatim for accurate recent context.

const SUMMARIZE_THRESHOLD = 15;  // trigger summarization when > 15 messages
const KEEP_RECENT = 12;          // always keep last N messages verbatim

/**
 * Build a lightweight topic summary from older messages.
 * Only extracts user messages — assistant replies are too verbose.
 * No LLM call needed — regex-based, runs in <1ms.
 */
function buildTopicSummary(messages) {
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);
  if (userMessages.length === 0) return '';

  // Extract key noun phrases and topics (simple heuristic)
  const topics = [];
  const seen = new Set();

  for (const msg of userMessages) {
    // Extract capitalized words, quoted phrases, and meaningful segments
    const clean = msg.replace(/[^\w\s@#\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = clean.split(' ').filter(w => w.length > 3 && !/^(?:nak|saya|aku|kau|dia|kami|kita|mereka|yang|dengan|pada|untuk|dalam|akan|telah|sudah|boleh|mesti|perlu|juga|sahaja|saja|pun|lagi|dah|ni|tu|ke|tak|kan|lah|nya|ini|itu|ada|tiada|bukan|tidak|ya|dan|atau|the|and|for|with|this|that|from|have|what|when|your|just|like|about)$/i.test(w)).slice(0, 5);
    for (const w of words) {
      if (!seen.has(w.toLowerCase())) {
        seen.add(w.toLowerCase());
        topics.push(w);
        if (topics.length >= 8) break;
      }
    }
    if (topics.length >= 8) break;
  }

  return topics.length > 0 ? '[Earlier topics: ' + topics.join(', ') + ']' : '';
}

/**
 * Get effective history for LLM context — auto-summarizes when too long.
 * Returns a history array optimized for token efficiency.
 */
function getEffectiveHistory(userId) {
  const history = getHistory(userId);
  if (history.length <= SUMMARIZE_THRESHOLD) return history;

  // Check if already summarized recently
  const firstMsg = history[0];
  const alreadySummarized = firstMsg && firstMsg.role === 'system' &&
    /^\[Earlier/.test(firstMsg.content);

  if (alreadySummarized) {
    // Keep the summary + last KEEP_RECENT messages
    const recent = history.slice(-KEEP_RECENT);
    return [firstMsg, ...recent];
  }

  // Build summary from older messages and replace history in-place
  const older = history.slice(0, history.length - KEEP_RECENT);
  const summary = buildTopicSummary(older);
  const recent = history.slice(-KEEP_RECENT);

  if (summary) {
    const newHistory = [{ role: 'system', content: summary }, ...recent];
    conversationHistory[userId] = newHistory;
    console.log('[Bot] 📝 Summarized ' + older.length + ' older messages → ' + summary.slice(0, 100));
    return newHistory;
  }

  // No useful summary — just trim (keep last 15)
  const trimmed = history.slice(-15);
  conversationHistory[userId] = trimmed;
  return trimmed;
}

// ── User Message Deduplication ─────────────────────────────────────────────
// Prevents re-processing the same user message within a short window.
// If user sends "hi" twice in 10 seconds, skip the second LLM call.

const recentUserMessages = new Map(); // userId → { text, timestamp, response }

function isDuplicateUserMessage(userId, text) {
  const entry = recentUserMessages.get(userId);
  if (!entry) return false;
  // Same text within 10 seconds → duplicate
  if (entry.text === text && Date.now() - entry.timestamp < 10000) {
    return true;
  }
  return false;
}

function cacheUserMessageResponse(userId, text, response) {
  recentUserMessages.set(userId, { text, timestamp: Date.now(), response });
  // Clean old entries periodically
  if (recentUserMessages.size > 50) {
    const cutoff = Date.now() - 30000;
    for (const [k, v] of recentUserMessages) {
      if (v.timestamp < cutoff) recentUserMessages.delete(k);
    }
  }
}

async function createBot() {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  const botName = await db.getConfig(OWNER_ID, 'bot_name', 'BOT_NAME', 'Jarvis');
  console.log('🤖 ' + botName + ' bot is online and polling...');

  // 💾 Restore conversation history from DB on startup
  await loadHistoryFromDB(OWNER_ID);

  // ── Guard: only respond to the owner ──────────────────────────────────────
  function isOwner(msg) {
    const match = String(msg.from.id) === OWNER_ID;
    if (!match) {
      console.log(`⛔ Blocked message from non-owner: ID=${msg.from.id}, Name=${msg.from.first_name}`);
    }
    return match;
  }

  // ── /start command ────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    console.log(`📩 /start from ID=${msg.from.id}, Name=${msg.from.first_name}`);
    if (!isOwner(msg)) {
      await bot.sendMessage(msg.chat.id, '⚠️ Sorry, you are not authorized. Your Telegram user ID is: `' + msg.from.id + '`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      const name = msg.from.first_name || 'Boss';
      await db.ensureUser(OWNER_ID, name);

      const welcome =
        'Hey ' + name + '! I\'m *' + botName + '*, your personal assistant. 🤖\n\n' +
        'You can talk to me naturally. Try:\n' +
        '• "Remind me to call mum at 6pm"\n' +
        '• "Add gym to my calendar tomorrow at 7am"\n' +
        '• "Note: look into React Native"\n' +
        '• "What\'s my schedule today?"\n' +
        '• "Remember that I prefer dark mode"\n\n' +
        'Type /status to check API connections.\n\n' +
        'I\'m ready when you are.';

      await safeSendMessage(bot, msg.chat.id, welcome);
    } catch (err) {
      console.error('/start error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Error: ' + err.message);
    }
  });

  // ── /today command shortcut ───────────────────────────────────────────────
  bot.onText(/\/today/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const result = await tools.executeTool(OWNER_ID, { name: 'get_today', args: {} });
    await safeSendMessage(bot, msg.chat.id, result);
  });

  // ── /notes command shortcut ───────────────────────────────────────────────
  bot.onText(/\/notes/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const notes = await db.getRecentNotes(OWNER_ID, 10);
    if (notes.length === 0) {
      return bot.sendMessage(msg.chat.id, 'No notes saved yet.');
    }
    let reply = '*Recent Notes* 📝\n\n';
    notes.forEach((n, i) => {
      const date = new Date(n.created_at).toLocaleDateString();
      reply += (i + 1) + '\. ' + escapeMd(n.content) + ' \_(' + date + ')\_\n\n';
    });
    await safeSendMessage(bot, msg.chat.id, reply.trim());
  });

  // ── /history command — search past conversations ─────────────────────────
  bot.onText(/\/history(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const query = (match[1] || '').trim();
    const results = await db.searchChatHistory(OWNER_ID, query, 10);

    if (results.length === 0) {
      return bot.sendMessage(msg.chat.id,
        query
          ? 'No past conversations matching "' + escapeMd(query) + '".'
          : 'No chat history yet. Start talking to me!');
    }

    let reply = query
      ? '*🔍 History: "' + escapeMd(query) + '"*\n\n'
      : '*💬 Recent Conversations*\n\n';

    results.forEach(r => {
      const date = fmt(r.created_at, 'MMM D, h:mm A');
      const icon = r.role === 'user' ? '👤' : '🤖';
      const truncated = r.content.length > 80 ? r.content.substring(0, 80) + '…' : r.content;
      reply += icon + ' _' + date + '_:\n' + escapeMd(truncated) + '\n\n';
    });

    try {
      await bot.sendMessage(msg.chat.id, reply.trim(), { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(msg.chat.id, reply.trim());
    }
  });

  // ── /memory command shortcut ──────────────────────────────────────────────
  bot.onText(/\/memory/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const facts = await db.getAllFacts(OWNER_ID);
    if (facts.length === 0) {
      return bot.sendMessage(msg.chat.id, 'No memory facts stored yet.');
    }
    let reply = '*Memory Facts* 🧠\n\n';
    facts.forEach(f => {
      reply += '• *' + escapeMd(f.key) + ':* ' + escapeMd(f.value) + '\n';
    });
    await safeSendMessage(bot, msg.chat.id, reply.trim());
  });

  // ── /people command — view all remembered people ─────────────────────────
  bot.onText(/\/people/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const people = await db.getRelationships(OWNER_ID, 20);
    const formatted = relationships.formatPeopleMessage(people, 'People You Know');

    try {
      await bot.sendMessage(msg.chat.id, formatted, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(msg.chat.id, formatted);
    }
  });

  // ── /person command — search for a specific person ───────────────────────
  bot.onText(/\/person(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const query = (match[1] || '').trim();
    if (!query) {
      return bot.sendMessage(msg.chat.id,
        'Usage: /person <name>\n\nExample: /person Sarah');
    }

    const results = await relationships.searchPeople(OWNER_ID, query, 5);
    if (results.length === 0) {
      return bot.sendMessage(msg.chat.id, '👤 *No match found* for "' + escapeMd(query) + '".\n\nTip: When you mention people in conversation, I automatically remember them.');
    }

    const formatted = relationships.formatPeopleMessage(results, 'Search: ' + query);

    try {
      await bot.sendMessage(msg.chat.id, formatted, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(msg.chat.id, formatted);
    }
  });

  // ── /verify command — review & resolve conflicting facts ─────────────────
  bot.onText(/\/verify/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const conflicts = await memory.getConflicts(OWNER_ID);
    if (conflicts.length === 0) {
      return bot.sendMessage(msg.chat.id, '✅ No conflicting facts. All memory is consistent!');
    }

    let reply = '*⚠️ Conflicting Facts — Please Review*\n\n';
    const inlineKeyboard = [];

    conflicts.forEach((c, i) => {
      reply += '*' + (i + 1) + '. ' + escapeMd(c.key) + '*\n';
      reply += '  🟢 *Current:* ' + escapeMd(c.value) + ' _(confidence: ' + (c.confidence || '?') + ')_\n';
      if (c.previous_value) {
        reply += '  🔴 *Previous:* ' + escapeMd(c.previous_value) + '\n';
      }
      reply += '\n';

      inlineKeyboard.push([{
        text: '✅ Keep "' + (c.value.length > 15 ? c.value.slice(0, 15) + '…' : c.value) + '"',
        callback_data: 'resolve_conflict:' + encodeURIComponent(c.key) + ':keep_current',
      }]);
      if (c.previous_value) {
        inlineKeyboard.push([{
          text: '↩️ Restore "' + (c.previous_value.length > 15 ? c.previous_value.slice(0, 15) + '…' : c.previous_value) + '"',
          callback_data: 'resolve_conflict:' + encodeURIComponent(c.key) + ':restore_previous',
        }]);
      }
    });

    try {
      await bot.sendMessage(msg.chat.id, reply.trim(), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch {
      await bot.sendMessage(msg.chat.id, reply.trim(), {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }
  });

  // ── /reflect command — generate today's reflection ───────────────────────
  bot.onText(/\/reflect/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');

    try {
      // Check if already generated today
      const existing = await db.getTodayReflection(OWNER_ID);
      if (existing) {
        await safeSendMessage(bot, msg.chat.id, '*🧘 Today\'s Reflection*\n\n' + existing.summary);
        return;
      }

      const reflection = await memory.generateDailyReflection(OWNER_ID, llm.chatMimo);
      if (reflection) {
        await safeSendMessage(bot, msg.chat.id, '*🧘 Today\'s Reflection*\n\n' + reflection);
      } else {
        await bot.sendMessage(msg.chat.id, '📭 Not enough activity today to reflect on. Talk to me more!');
      }
    } catch (err) {
      console.error('/reflect error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate reflection.');
    }
  });

  // ── /patterns command — view detected behavioral patterns ───────────────
  bot.onText(/\/patterns(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');

    try {
      const filterType = (match[1] || '').trim().toLowerCase();
      const validTypes = ['usage', 'topic', 'behavior', 'trend', 'correlation'];

      const options = {};
      if (validTypes.includes(filterType)) {
        options.type = filterType;
      }

      const detectedPatterns = await patterns.getPatterns(OWNER_ID, {
        ...options,
        minConfidence: 0.4,
        limit: 20,
      });

      if (detectedPatterns.length === 0) {
        const typeMsg = filterType ? ' for type "' + filterType + '"' : '';
        return bot.sendMessage(msg.chat.id,
          '🔍 *No patterns detected yet' + typeMsg + '.*\n\n' +
          'Keep using me and I\'ll start noticing patterns in your behavior and conversations!\n\n' +
          '_Patterns are analyzed daily at 11 PM. Use /patterns usage|topic|behavior|trend|correlation to filter._');
      }

      const formatted = patterns.formatPatternsMessage(detectedPatterns);

      try {
        await bot.sendMessage(msg.chat.id, formatted, { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(msg.chat.id, formatted);
      }
    } catch (err) {
      console.error('/patterns error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve patterns.');
    }
  });

  // ── /tasks command — list active tasks ──────────────────────────────────
  bot.onText(/\/tasks/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const result = await tools.executeTool(OWNER_ID, { name: 'list_tasks', args: {} });
    await safeSendMessage(bot, msg.chat.id, typeof result === 'object' ? result.message : result);
  });

  // ── /goals command — list all goals ─────────────────────────────────────
  bot.onText(/\/goals/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const result = await tools.executeTool(OWNER_ID, { name: 'list_goals', args: {} });
    await safeSendMessage(bot, msg.chat.id, typeof result === 'object' ? result.message : result);
  });

  // ═══════════════════════════════════════════════════════════════════
  // ── FASA 1-5: New Intelligent Commands ─────────────────────────────
  // ═══════════════════════════════════════════════════════════════════

  // ── /plan command — view active plans (Fasa 4) ──────────────────────────
  bot.onText(/\/plan(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const subCommand = (match[1] || '').trim().toLowerCase();
    const planner = require('../executive/planner');

    if (subCommand === 'create' || subCommand === 'new') {
      return bot.sendMessage(msg.chat.id,
        '📋 *Create a Plan*\n\n' +
        'Just tell me naturally what you want to achieve, for example:\n' +
        '• "Plan: Learn React Native in 2 weeks"\n' +
        '• "Help me plan my project deployment"\n' +
        '• "Buat plan untuk belajar Python"\n\n' +
        'I\'ll break it down into steps for you!');
    }

    const activePlans = planner.getPlans(OWNER_ID).filter(p => p.status === 'active');
    if (activePlans.length === 0) {
      return bot.sendMessage(msg.chat.id,
        '📋 *No active plans.*\n\n' +
        'Create one by saying something like:\n' +
        '• "Plan: Learn X in Y weeks"\n' +
        '• "Help me break down [task] into steps"');
    }

    let reply = '*📋 Active Plans*\n\n';
    for (const plan of activePlans) {
      reply += '🎯 *' + escapeMd(plan.goal) + '*\n';
      reply += '  Progress: ' + plan.progress + '% | Steps: ' + plan.steps.length + '\n';
      const nextStep = planner.getNextStep(OWNER_ID, plan.planId);
      if (nextStep) {
        reply += '  ➡️ Next: ' + escapeMd(nextStep.description) + '\n';
      }
      reply += '\n';
    }

    await safeSendMessage(bot, msg.chat.id, reply.trim());
  });

  // ── /domains command — view memory domains (Fasa 3) ────────────────────
  bot.onText(/\/domains/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const domains = require('../memory/domains');
      const stats = await domains.getDomainStats(OWNER_ID);

      if (stats.every(s => s.count === 0)) {
        return bot.sendMessage(msg.chat.id,
          '🧠 *No memory domains yet.*\n\n' +
          'As we talk, I\'ll organize what I learn about you into domains like Personal, Work, Health, etc.');
      }

      let reply = '*🧠 Memory Domains*\n\n';
      for (const s of stats) {
        if (s.count === 0) continue;
        const bar = '█'.repeat(Math.min(s.count, 20));
        reply += s.icon + ' *' + s.name + ':* ' + s.count + ' facts\n';
        reply += '  ' + bar + '\n\n';
      }

      try {
        await bot.sendMessage(msg.chat.id, reply.trim(), { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(msg.chat.id, reply.trim());
      }
    } catch (err) {
      console.error('/domains error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve domains.');
    }
  });

  // ── /evaluate command — view self-evaluation stats (Fasa 5) ────────────
  bot.onText(/\/evaluate/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const evaluator = require('../executive/evaluator');
      const summary = evaluator.getLearningSummary(OWNER_ID);

      if (!summary) {
        return bot.sendMessage(msg.chat.id,
          '📊 *No evaluation data yet.*\n\nInteract with me more and I\'ll start tracking my performance!');
      }

      const wm = executive.worldModel.get(OWNER_ID);
      let reply = '*📊 Self-Evaluation Report*\n\n' + summary + '\n\n';

      if (wm) {
        reply += '*Current State:*\n';
        reply += '• Status: ' + (wm.status || 'unknown') + '\n';
        reply += '• Domain: ' + (wm.activeDomain || 'general') + '\n';
        reply += '• Mood: ' + (wm.currentMood || 'neutral') + '\n';
        reply += '• Messages: ' + wm.messageCount + '\n';
      }

      await safeSendMessage(bot, msg.chat.id, reply.trim());
    } catch (err) {
      console.error('/evaluate error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate evaluation.');
    }
  });

  // ── /proactive command — trigger proactive suggestion (Fasa 5) ─────────
  bot.onText(/\/proactive/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const proactive = require('../executive/proactive');
      const result = await proactive.getBestProactiveMessage(OWNER_ID, bot);

      if (result) {
        await safeSendMessage(bot, msg.chat.id, result.message);
      } else {
        await bot.sendMessage(msg.chat.id,
          '💤 *Nothing to suggest right now.*\n\n' +
          'I\'ll proactively check in when:\n' +
          '• It\'s morning/evening\n' +
          '• You have stalled plans\n' +
          '• Your mood seems off\n' +
          '• You haven\'t chatted in a while');
      }
    } catch (err) {
      console.error('/proactive error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate suggestion.');
    }
  });

  // ── /state command — view full bot state (all Fasa) ────────────────────
  bot.onText(/\/state/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const wm = executive.worldModel.get(OWNER_ID);
      const wrkMem = executive.workingMemory.get(OWNER_ID);
      const activePlan = require('../executive/planner').getActivePlan(OWNER_ID);
      const domains = require('../memory/domains');
      const stats = await domains.getDomainStats(OWNER_ID);
      const evaluator = require('../executive/evaluator');
      const evalStats = evaluator.getStats(OWNER_ID);

      let reply = '*🤖 JARVIS STATE REPORT*\n\n';

      reply += '*🌍 World Model:*\n';
      reply += '• Status: ' + (wm.status || 'unknown') + '\n';
      reply += '• Domain: ' + (wm.activeDomain || 'general') + '\n';
      reply += '• Mood: ' + (wm.currentMood || 'neutral') + '\n';
      reply += '• Project: ' + (wm.currentProject || 'none') + '\n';
      reply += '• Messages: ' + wm.messageCount + '\n\n';

      reply += '*🧠 Working Memory:*\n';
      reply += '• Goal: ' + (wrkMem.currentGoal || 'none') + '\n';
      reply += '• Problem: ' + (wrkMem.currentProblem || 'none') + '\n';
      reply += '• Steps: ' + (wrkMem.nextSteps.length > 0 ? wrkMem.nextSteps.join(', ') : 'none') + '\n\n';

      if (activePlan) {
        reply += '*📋 Active Plan:*\n';
        reply += '• Goal: ' + activePlan.goal + '\n';
        reply += '• Progress: ' + activePlan.progress + '%\n';
        reply += '• Steps: ' + activePlan.steps.filter(s => s.status === 'completed').length + '/' + activePlan.steps.length + ' done\n\n';
      }

      reply += '*📊 Domains:*\n';
      stats.filter(s => s.count > 0).forEach(s => {
        reply += '• ' + s.icon + ' ' + s.name + ': ' + s.count + '\n';
      });
      reply += '\n';

      reply += '*📈 Eval Stats:*\n';
      reply += '• Total interactions: ' + evalStats.totalInteractions + '\n';
      reply += '• Avg quality: ' + evalStats.avgQuality + '%\n';
      reply += '• Fast/Med/Deep: ' + evalStats.byTier.fast + '/' + evalStats.byTier.medium + '/' + evalStats.byTier.deep + '\n';

      try {
        await bot.sendMessage(msg.chat.id, reply.trim(), { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(msg.chat.id, reply.trim());
      }
    } catch (err) {
      console.error('/state error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve state. ' + err.message);
    }
  });

  // ── /reminders command ────────────────────────────────────────────────────
  bot.onText(/\/reminders/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const reminders = await db.getUpcomingReminders(OWNER_ID, 15);

    if (reminders.length === 0) {
      return bot.sendMessage(msg.chat.id, 'You have no upcoming reminders. 🎉');
    }

    let reply = '*Upcoming Reminders* ⏰\n\n';
    const inlineKeyboard = [];

    reminders.forEach(r => {
      const t = fmt(r.remind_at, 'ddd, D MMM [at] h:mm A');
      const recurring = r.recurrence ? ' 🔁' : '';
      reply += '• ' + t + ' — ' + escapeMd(r.text) + recurring + '\n';

      inlineKeyboard.push([{
        text: '❌ Cancel: ' + (r.text.length > 20 ? r.text.substring(0, 20) + '…' : r.text),
        callback_data: 'cancel_reminder:' + r.id,
      }]);
    });

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    };

    try {
      await bot.sendMessage(msg.chat.id, reply.trim(), opts);
    } catch (mdErr) {
      // Fallback to plain text if Markdown fails
      await bot.sendMessage(msg.chat.id, reply.trim().replace(/[_*`\[]/g, ''), {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }
  });

  // ── Callback query handler: cancel reminders + confirm config changes ─────
  bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const msgId = callbackQuery.message.message_id;
    const userId = String(callbackQuery.from.id);

    // ── Confirm config change ────────────────────────────────────────────
    if (data.startsWith('confirm_config')) {
      try {
        const pending = await confirmPendingConfig(userId);
        if (!pending) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '⏰ Expired or no pending change.' });
          return;
        }

        // Clear conversation history for name/personality changes so new style takes effect
        if (pending.key === 'bot_name' || pending.key === 'bot_personality') {
          clearHistory(userId);
          invalidateConfigCache(userId);
        }

        // Refresh cron if time setting changed
        if (pending.envKey === 'MORNING_BRIEFING_TIME' || pending.envKey === 'REFLECTION_TIME' || pending.envKey === 'WEEKLY_REVIEW_TIME') {
          try {
            const { refreshSchedules } = require('../scheduler');
            if (typeof refreshSchedules === 'function') await refreshSchedules();
          } catch { /* scheduler may not be loaded */ }
        }

        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Updated!' });
        await bot.editMessageText(
          '✅ *' + pending.label + ' updated!*\n\n' + escapeMd(pending.value),
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Config confirm error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed. Try again.' });
      }
      return;
    }

    // ── Cancel config change ─────────────────────────────────────────────
    if (data.startsWith('cancel_config')) {
      removePendingConfig(userId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Cancelled.' });
      try {
        await bot.editMessageText(
          '❌ *Change cancelled.*',
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
      } catch {
        await bot.editMessageText('❌ Change cancelled.', { chat_id: chatId, message_id: msgId });
      }
      return;
    }

    // ── Revert config ────────────────────────────────────────────────────
    if (data.startsWith('revert_config:')) {
      const key = data.split(':')[1];
      try {
        const result = await tools.executeTool(userId, { name: 'revert_config', args: { key } });
        // Clear history if name/personality reverted
        if (key === 'bot_name' || key === 'bot_personality') {
          clearHistory(userId);
        }
        await bot.answerCallbackQuery(callbackQuery.id, { text: '↩️ Reverted!' });
        try {
          await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        } catch {
          await bot.editMessageText(result, { chat_id: chatId, message_id: msgId });
        }
      } catch (err) {
        console.error('Revert config error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to revert.' });
      }
      return;
    }

    // ── Edit reminder: prompt user for changes ──────────────────────────
    if (data.startsWith('edit_reminder:')) {
      const reminderId = parseInt(data.split(':')[1], 10);
      if (isNaN(reminderId)) return;
      await bot.answerCallbackQuery(callbackQuery.id);

      // Fetch reminder text for context
      let label = 'reminder #' + reminderId;
      try {
        const reminders = await db.getUpcomingReminders(userId, 50);
        const found = reminders.find(r => r.id === reminderId);
        if (found) label = '"' + found.text + '"';
      } catch { /* ignore */ }

      setPendingEdit(userId, 'reminder', reminderId, label);

      await bot.sendMessage(chatId,
        '✏️ *Editing ' + escapeMd(label) + ' (#' + reminderId + ')*\n\n' +
        'Just tell me what to change. Contoh:\n' +
        '• "Tukar ke pukul 3 petang"\n' +
        '• "Change to 8pm tomorrow"\n' +
        '• "Repeat daily"',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ── Edit event: prompt user for changes ──────────────────────────────
    if (data.startsWith('edit_event:')) {
      const eventId = parseInt(data.split(':')[1], 10);
      if (isNaN(eventId)) return;
      await bot.answerCallbackQuery(callbackQuery.id);

      let label = 'event #' + eventId;
      setPendingEdit(userId, 'event', eventId, label);

      await bot.sendMessage(chatId,
        '✏️ *Editing ' + escapeMd(label) + ' (#' + eventId + ')*\n\n' +
        'Just tell me what to change. Contoh:\n' +
        '• "Tukar ke pukul 3 petang"\n' +
        '• "Change title to Team meeting"\n' +
        '• "Change duration to 30 min"',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ── Cancel event ─────────────────────────────────────────────────────
    if (data.startsWith('cancel_event:')) {
      const eventId = parseInt(data.split(':')[1], 10);
      if (isNaN(eventId)) return;
      try {
        await db.cancelEvent(eventId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🗑️ Event cancelled!' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Cancel event error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to cancel. Try again.' });
      }
      return;
    }

    // ── Delete note ──────────────────────────────────────────────────────
    if (data.startsWith('delete_note:')) {
      const noteId = parseInt(data.split(':')[1], 10);
      if (isNaN(noteId)) return;
      try {
        await db.deleteNote(noteId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🗑️ Note deleted!' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Delete note error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to delete. Try again.' });
      }
      return;
    }

    // ── Forget fact ──────────────────────────────────────────────────────
    if (data.startsWith('forget_fact:')) {
      const factKey = decodeURIComponent(data.split(':').slice(1).join(':'));
      if (!factKey) return;
      try {
        await db.deleteFact(userId, factKey);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🧠 Fact forgotten!' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Forget fact error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to forget. Try again.' });
      }
      return;
    }

    // ── Resolve conflict ─────────────────────────────────────────────────
    if (data.startsWith('resolve_conflict:')) {
      const parts = data.split(':');
      const factKey = decodeURIComponent(parts[1]);
      const resolution = parts[2]; // 'keep_current' or 'restore_previous'
      if (!factKey || !resolution) return;

      try {
        await memory.resolveConflict(userId, factKey, resolution);
        const label = resolution === 'restore_previous' ? '↩️ Restored previous value!' : '✅ Kept current value!';
        await bot.answerCallbackQuery(callbackQuery.id, { text: label });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Resolve conflict error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to resolve. Try again.' });
      }
      return;
    }

    // ── Task actions ─────────────────────────────────────────────────────
    if (data.startsWith('start_task:') || data.startsWith('complete_task:') || data.startsWith('cancel_task:')) {
      const [action, idStr] = data.split(':');
      const taskId = parseInt(idStr, 10);
      if (isNaN(taskId)) return;

      const toolName = action === 'start_task' ? 'start_task' : action === 'complete_task' ? 'complete_task' : 'cancel_task';
      try {
        const result = await tools.executeTool(userId, { name: toolName, args: { task_id: taskId } });
        await bot.answerCallbackQuery(callbackQuery.id, { text: action === 'start_task' ? '🚀 Started!' : action === 'complete_task' ? '🎉 Done!' : '❌ Cancelled' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
        const msg = typeof result === 'object' ? result.message : result;
        try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch { await bot.sendMessage(chatId, msg); }
      } catch (err) {
        console.error('Task action error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed. Try again.' });
      }
      return;
    }

    // ── Goal actions ─────────────────────────────────────────────────────
    if (data.startsWith('complete_goal:') || data.startsWith('abandon_goal:')) {
      const [action, idStr] = data.split(':');
      const goalId = parseInt(idStr, 10);
      if (isNaN(goalId)) return;

      const toolName = action === 'complete_goal' ? 'complete_goal' : 'abandon_goal';
      try {
        const result = await tools.executeTool(userId, { name: toolName, args: { goal_id: goalId } });
        await bot.answerCallbackQuery(callbackQuery.id, { text: action === 'complete_goal' ? '🏆 Achieved!' : '🗑️ Abandoned' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
        const msg = typeof result === 'object' ? result.message : result;
        try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch { await bot.sendMessage(chatId, msg); }
      } catch (err) {
        console.error('Goal action error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed. Try again.' });
      }
      return;
    }

    // ── Dismiss reminder (mark as done) ──────────────────────────────────
    if (data.startsWith('dismiss_reminder:')) {
      const reminderId = parseInt(data.split(':')[1], 10);
      if (isNaN(reminderId)) return;
      try {
        await db.markReminderSent(reminderId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Done!' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Dismiss reminder error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed. Try again.' });
      }
      return;
    }

    // ── Snooze reminder ──────────────────────────────────────────────────
    if (data.startsWith('snooze_reminder:')) {
      const reminderId = parseInt(data.split(':')[1], 10);
      if (isNaN(reminderId)) return;
      try {
        const snoozed = await db.snoozeReminder(reminderId, 10);
        if (!snoozed) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Reminder not found.' });
          return;
        }
        const newTime = fmt(snoozed.remind_at, 'h:mm A');
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🔁 Snoozed 10 min → ' + newTime });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
        await bot.sendMessage(chatId, '🔁 Reminder snoozed for 10 minutes — will remind again at *' + escapeMd(newTime) + '*.', { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Snooze reminder error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to snooze.' });
      }
      return;
    }

    // ── 🔧 View list buttons ──────────────────────────────────────────────
    // list_reminders, get_today, list_notes, list_tasks, list_goals
    if (data === 'list_reminders' || data === 'get_today' ||
      data === 'list_notes' || data === 'list_tasks' || data === 'list_goals') {

      const toolMap = {
        list_reminders: 'list_reminders',
        get_today: 'get_today',
        list_tasks: 'list_tasks',
        list_goals: 'list_goals',
      };

      await bot.answerCallbackQuery(callbackQuery.id);

      if (data === 'list_notes') {
        // list_notes has no dedicated tool — query DB directly
        try {
          const notes = await db.getRecentNotes(userId, 15);
          if (notes.length === 0) {
            await safeSendMessage(bot, chatId, '📝 No notes saved yet.');
          } else {
            let reply = '*📝 All Notes*\n\n';
            notes.forEach((n, i) => {
              const date = fmt(n.created_at, 'MMM D, h:mm A');
              reply += (i + 1) + '\\. ' + escapeMd(n.content) + ' \\_(' + date + ')\\_\n\n';
            });
            await safeSendMessage(bot, chatId, reply.trim());
          }
        } catch (err) {
          console.error('list_notes callback error:', err.message);
          await bot.sendMessage(chatId, '❌ Could not retrieve notes.');
        }
        return;
      }

      // For list_reminders, get_today, list_tasks, list_goals — use executeTool
      try {
        const toolName = toolMap[data];
        const result = await tools.executeTool(userId, { name: toolName, args: {} });
        const msg = typeof result === 'object' ? result.message : result;
        await safeSendMessage(bot, chatId, msg);
      } catch (err) {
        console.error(data + ' callback error:', err.message);
        await bot.sendMessage(chatId, '❌ Could not retrieve data. Try again.');
      }
      return;
    }

    // ── 🔧 New-item prompt buttons ───────────────────────────────────────
    // new_reminder, new_task, new_goal
    if (data === 'new_reminder' || data === 'new_task' || data === 'new_goal') {
      await bot.answerCallbackQuery(callbackQuery.id);

      const prompts = {
        new_reminder: '⏰ *New Reminder*\n\nJust tell me what you want to be reminded about. Contoh:\n• "Remind me to call mom at 3pm"\n• "Ingatkan saya minum air setiap jam 9 pagi"',
        new_task: '📋 *New Task*\n\nDescribe your task and I\'ll create it. Contoh:\n• "Add task: Finish report by Friday, high priority"\n• "Tambah task: Kemas rumah before weekend"',
        new_goal: '🎯 *New Goal*\n\nWhat goal do you want to set? Contoh:\n• "Set goal: Learn TypeScript by end of month"\n• "Goal: Kurus 5kg dalam 2 bulan"',
      };

      await safeSendMessage(bot, chatId, prompts[data]);
      return;
    }

    // ── 🔧 Save search result as note ────────────────────────────────────
    if (data.startsWith('save_search_note:')) {
      const queryText = decodeURIComponent(data.split(':').slice(1).join(':'));
      await bot.answerCallbackQuery(callbackQuery.id, { text: '📝 Saved!' });

      try {
        // Extract the search result text from the message (strip Markdown formatting)
        const msgText = callbackQuery.message.text || callbackQuery.message.caption || '';
        // Remove the "🔍 Search: ..." header line and inline keyboard note
        const cleanText = msgText
          .replace(/^🔍[^\n]*\n+/s, '')
          .replace(/\n\n_🔍[^\n]*_$/, '')
          .trim();

        const noteContent = '🔍 Search: ' + queryText + '\n\n' + (cleanText || msgText);
        await db.addNote(userId, noteContent);

        // Remove the save button from the message
        const currentKeyboard = callbackQuery.message.reply_markup?.inline_keyboard || [];
        const newKeyboard = currentKeyboard
          .map(row => row.filter(btn => !btn.callback_data.startsWith('save_search_note:')))
          .filter(row => row.length > 0);

        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: newKeyboard },
            { chat_id: chatId, message_id: msgId }
          );
        } catch { /* non-critical */ }
      } catch (err) {
        console.error('save_search_note callback error:', err.message);
        await bot.sendMessage(chatId, '❌ Could not save note.');
      }
      return;
    }

    // ── Cancel reminder (existing) ───────────────────────────────────────
    if (!data.startsWith('cancel_reminder:')) return;

    const reminderId = parseInt(data.split(':')[1], 10);
    if (isNaN(reminderId)) return;

    try {
      await db.cancelReminder(reminderId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Reminder cancelled! ✅' });

      // Edit the original message to remove the cancelled button
      const currentText = callbackQuery.message.text || callbackQuery.message.caption || '';
      const currentKeyboard = callbackQuery.message.reply_markup.inline_keyboard;

      // Remove the clicked button
      const newKeyboard = currentKeyboard
        .map(row => row.filter(btn => btn.callback_data !== data))
        .filter(row => row.length > 0);

      await bot.editMessageReplyMarkup(
        { inline_keyboard: newKeyboard },
        { chat_id: chatId, message_id: msgId }
      );
    } catch (err) {
      console.error('Cancel reminder error:', err.message);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to cancel. Try again.' });
    }
  });

  // ── /briefing command ─────────────────────────────────────────────────────
  bot.onText(/\/briefing/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const message = await buildBriefingMessage();
      await safeSendMessage(bot, msg.chat.id, message);
    } catch (err) {
      console.error('/briefing error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate briefing.');
    }
  });

  // ── /review command ──────────────────────────────────────────────────────
  bot.onText(/\/review/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const { buildWeeklyReview } = require('../scheduler');
      const message = await buildWeeklyReview();
      await safeSendMessage(bot, msg.chat.id, message);
    } catch (err) {
      console.error('/review error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate weekly review.');
    }
  });

  // ── /quote command ────────────────────────────────────────────────────────
  bot.onText(/\/quote/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const quote = await getQuote();
      await safeSendMessage(bot, msg.chat.id, quote);
    } catch (err) {
      console.error('/quote error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not fetch a quote.');
    }
  });

  // ── /help command ─────────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isOwner(msg)) return;
    const help =
      '*Jarvis Commands* 🤖\n\n' +
      '/start — Wake up Jarvis\n' +
      '/today — See today\'s schedule\n' +
      '/briefing — Morning briefing (events, reminders, weather, quote)\n' +
      '/review — Weekly review summary\n' +
      '/quote — Get a motivational quote\n' +
      '/notes — View recent notes\n' +
      '/reminders — List upcoming reminders\n' +
      '/tasks — List active tasks\n' +
      '/goals — View your goals & progress\n' +
      '/memory — See stored facts\n' +
      '/people — View remembered people & relationships\n' +
      '/person <name> — Search for a specific person\n' +
      '/verify — Review & resolve conflicting facts\n' +
      '/reflect — Generate daily reflection & insights\n' +
      '/patterns — View detected behavioral patterns (/patterns <type>)\n' +
      '/history — Search past conversations (/history <keyword>)\n' +
      '/status — Check API connections\n' +
      '/features — List all active capabilities & modules\n' +
      '/help — This message\n' +
      '/settings — View current bot settings\n' +
      '/setname <name> — Change bot name\n' +
      '/setpersonality <text> — Change bot personality\n' +
      '/setlocation <city> — Change weather location\n' +
      '/setbriefing <HH:MM> — Change morning briefing time\n' +
      '/setreview <HH:MM> — Change weekly review time\n\n' +
      '*Or just talk to me naturally!*\n' +
      'Examples:\n' +
      '• "Remind me to take meds at 8pm"\n' +
      '• "Remind me to drink water every day at 9am"\n' +
      '• "Add standup to calendar at 9am tomorrow"\n' +
      '• "Note: follow up with client on Friday"\n' +
      '• "Remember I wake up at 6am"\n' +
      '• "What\'s my day looking like?"\n' +
      '• "Cancel reminder #3"\n\n' +
      '🎤 *You can also send voice messages!*';
    await safeSendMessage(bot, msg.chat.id, help);
  });

  // ── /settings command ─────────────────────────────────────────────────────
  bot.onText(/\/settings/, async (msg) => {
    if (!isOwner(msg)) return;
    try {
      const settings = await db.getAllSettings(OWNER_ID);
      const botName = settings.bot_name || process.env.BOT_NAME || 'Jarvis';
      const personality = settings.bot_personality || process.env.BOT_PERSONALITY || '(not set)';
      const briefingTime = settings.morning_briefing_time || process.env.MORNING_BRIEFING_TIME || '7:00';
      const reviewTime = settings.weekly_review_time || process.env.WEEKLY_REVIEW_TIME || '20:00';
      const location = settings.weather_location || process.env.WEATHER_LOCATION || '(not set)';

      // Check for previous (revertable) values
      const hasPrev = (k) => settings['prev_' + k] && settings['prev_' + k].trim() !== '';

      let reply =
        '*⚙️ Current Settings*\n\n' +
        '🤖 *Bot Name:* ' + escapeMd(botName) + (hasPrev('bot_name') ? ' ↩️' : '') + '\n' +
        '🎭 *Personality:* ' + escapeMd(personality.length > 80 ? personality.slice(0, 80) + '…' : personality) + (hasPrev('bot_personality') ? ' ↩️' : '') + '\n' +
        '🌅 *Morning Briefing:* ' + escapeMd(briefingTime) + (hasPrev('morning_briefing_time') ? ' ↩️' : '') + '\n' +
        '📊 *Weekly Review:* ' + escapeMd(reviewTime) + ' (Sunday)' + (hasPrev('weekly_review_time') ? ' ↩️' : '') + '\n' +
        '🌤️ *Weather Location:* ' + escapeMd(location) + (hasPrev('weather_location') ? ' ↩️' : '') + '\n\n' +
        '_Use /setname, /setpersonality, /setlocation, /setbriefing, /setreview to change._\n' +
        '_↩️ = can be reverted with /revert_';

      await safeSendMessage(bot, msg.chat.id, reply);
    } catch (err) {
      console.error('/settings error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not fetch settings.');
    }
  });

  // ── /revert command ───────────────────────────────────────────────────────
  bot.onText(/\/revert/, async (msg) => {
    if (!isOwner(msg)) return;
    try {
      const settings = await db.getAllSettings(OWNER_ID);
      const revertable = [];

      const labels = {
        bot_name: 'Bot Name', bot_personality: 'Bot Personality',
        morning_briefing_time: 'Morning Briefing Time', reflection_time: 'Daily Reflection Time',
        weekly_review_time: 'Weekly Review Time', weather_location: 'Weather Location',
      };

      for (const [key, label] of Object.entries(labels)) {
        const prevVal = settings['prev_' + key];
        if (prevVal && prevVal.trim() !== '') {
          revertable.push({ key, label, prev: prevVal });
        }
      }

      if (revertable.length === 0) {
        return bot.sendMessage(msg.chat.id, 'No previous settings to revert to. Make a change first!');
      }

      const inlineKeyboard = revertable.map(r => ([{
        text: '↩️ ' + r.label + ' → ' + (r.prev.length > 25 ? r.prev.slice(0, 25) + '…' : r.prev),
        callback_data: 'revert_config:' + r.key,
      }]));

      await bot.sendMessage(msg.chat.id, '*↩️ Revert a setting to its previous value:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch (err) {
      console.error('/revert error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not check revert options.');
    }
  });

  // ── /setname command ──────────────────────────────────────────────────────
  bot.onText(/\/setname (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!value) return bot.sendMessage(msg.chat.id, 'Usage: /setname <name>');
    const currentVal = await db.getConfig(OWNER_ID, 'bot_name', 'BOT_NAME');
    setPendingConfig(OWNER_ID, 'bot_name', 'BOT_NAME', value, 'Bot Name');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Bot Name* → ' + escapeMd(value) + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /setpersonality command ───────────────────────────────────────────────
  bot.onText(/\/setpersonality (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!value) return bot.sendMessage(msg.chat.id, 'Usage: /setpersonality <text>');
    const currentVal = await db.getConfig(OWNER_ID, 'bot_personality', 'BOT_PERSONALITY');
    setPendingConfig(OWNER_ID, 'bot_personality', 'BOT_PERSONALITY', value, 'Bot Personality');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal.length > 50 ? currentVal.slice(0, 50) + '…' : currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Bot Personality* → ' + escapeMd(value.length > 80 ? value.slice(0, 80) + '…' : value) + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /setlocation command ──────────────────────────────────────────────────
  bot.onText(/\/setlocation (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!value) return bot.sendMessage(msg.chat.id, 'Usage: /setlocation <city>');
    const currentVal = await db.getConfig(OWNER_ID, 'weather_location', 'WEATHER_LOCATION');
    setPendingConfig(OWNER_ID, 'weather_location', 'WEATHER_LOCATION', value, 'Weather Location');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Weather Location* → ' + escapeMd(value) + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /setbriefing command ──────────────────────────────────────────────────
  bot.onText(/\/setbriefing (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!/^\d{1,2}:\d{2}$/.test(value)) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid format. Use 24h time, e.g. `/setbriefing 7:00`');
    }
    const currentVal = await db.getConfig(OWNER_ID, 'morning_briefing_time', 'MORNING_BRIEFING_TIME');
    setPendingConfig(OWNER_ID, 'morning_briefing_time', 'MORNING_BRIEFING_TIME', value, 'Morning Briefing Time');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Morning Briefing Time* → ' + escapeMd(value) + ' daily' + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /setreview command ────────────────────────────────────────────────────
  bot.onText(/\/setreview (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!/^\d{1,2}:\d{2}$/.test(value)) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid format. Use 24h time, e.g. `/setreview 20:00`');
    }
    const currentVal = await db.getConfig(OWNER_ID, 'weekly_review_time', 'WEEKLY_REVIEW_TIME');
    setPendingConfig(OWNER_ID, 'weekly_review_time', 'WEEKLY_REVIEW_TIME', value, 'Weekly Review Time');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Weekly Review Time* → ' + escapeMd(value) + ' Sunday' + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /status command ───────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const statuses = await getApiStatus(bot);
      const message = formatStatusMessage(statuses);
      await safeSendMessage(bot, msg.chat.id, message);
    } catch (err) {
      console.error('/status error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not check API status.');
    }
  });

  // ── /features command — list all active capabilities ──────────────────────
  bot.onText(/\/features/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const message = formatFeaturesMarkdown();
      await safeSendMessage(bot, msg.chat.id, message);
    } catch (err) {
      console.error('/features error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve features list.');
    }
  });

  // ── /why command — explain the bot's last decision ────────────────────────
  bot.onText(/\/why/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const explanation = stateMachine.formatWhy(OWNER_ID);
      await safeSendMessage(bot, msg.chat.id, explanation);
    } catch (err) {
      console.error('/why error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve execution trace.');
    }
  });

  // ── /trace command — show last execution trace with full observability ────
  bot.onText(/\/trace(?:\s+(\d+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const count = match && match[1] ? Math.min(parseInt(match[1], 10), 10) : 3;
      const traces = stateMachine.getRecentTraces(OWNER_ID, count);

      if (traces.length === 0) {
        return bot.sendMessage(msg.chat.id, '🤷 No execution traces found. Send me a message first!');
      }

      let report = '🔍 **Last ' + traces.length + ' Execution Traces**\n\n';
      for (const t of traces) {
        report += '`' + t.traceId + '` — ' + (t.durationMs || '?') + 'ms — **' + t.finalState + '**\n';
        report += '  User: ' + (t.userMessage || '(none)').slice(0, 60) + '\n';
        report += '  Phases: ' + t.transitions.map(tr => tr.from + '→' + tr.to).join(', ') + '\n\n';
      }

      // Add latency stats
      const latencyStats = trace.getLatencyStats(OWNER_ID);
      if (Object.keys(latencyStats).length > 0) {
        report += '📊 **Avg Latency per Phase:**\n';
        for (const [phase, stats] of Object.entries(latencyStats)) {
          report += '  ' + phase + ': avg=' + stats.avgMs + 'ms, p95=' + stats.p95Ms + 'ms (n=' + stats.count + ')\n';
        }
      }

      await safeSendMessage(bot, msg.chat.id, report);
    } catch (err) {
      console.error('/trace error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve traces.');
    }
  });

  // ── /lifecycle command — show conversation phase & engagement ────────────
  bot.onText(/\/lifecycle/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const report = lifecycle.formatLifecycle(OWNER_ID);
      await safeSendMessage(bot, msg.chat.id, report);
    } catch (err) {
      console.error('/lifecycle error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve lifecycle info.');
    }
  });

  // ── Shared text processing (used by both text and voice messages) ─────────
  async function processUserText(bot, chatId, userId, userName, text, messageId = null) {
    await db.ensureUser(userId, userName);

    // ── 🚫 User message dedup: skip if same text within 10 seconds ──────
    if (isDuplicateUserMessage(userId, text)) {
      console.log('[Bot] 🚫 Skipped duplicate message: "' + text.slice(0, 60) + '"');
      return; // silently ignore — user probably double-tapped send
    }
    cacheUserMessageResponse(userId, text, null); // mark as seen

    // ── 🔄 Re-send typing indicator every 4s (Telegram expires it after ~5s) ──
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => { });
    }, 4000);
    // Initial typing indicator
    await bot.sendChatAction(chatId, 'typing');
    // Cleanup helper — call when done
    const stopTyping = () => { clearInterval(typingInterval); };

    // ── 📡 Emit message:received event ──────────────────────────────────
    eventBus.emitSync(EVENTS.MESSAGE_RECEIVED, {
      userId,
      chatId,
      userName,
      text,
      timestamp: new Date().toISOString(),
    });

    // ── 🔌 Run plugin message hooks (before core processing) ────────────
    const pluginResults = await pluginRegistry.runMessageHooks({
      userId,
      chatId,
      message: text,
      bot,
    });
    // Log any plugin activity
    for (const pr of pluginResults) {
      console.log('[Bot] Plugin "' + pr.plugin + '" returned:', JSON.stringify(pr.result).slice(0, 100));
    }

    // ── � Lifecycle: track conversation phase ───────────────────────────
    const phaseInfo = lifecycle.onMessageReceived(userId);
    if (phaseInfo.transitioned) {
      console.log('[Lifecycle] Phase: ' + phaseInfo.previousPhase + ' → ' + phaseInfo.phase);
      eventBus.emitSync(EVENTS.LIFECYCLE_CHANGED, {
        userId,
        from: phaseInfo.previousPhase,
        to: phaseInfo.phase,
      });
    }

    // ── �🔍 Create execution pipeline (state machine + tracing) ─────────────
    const { sm, traceId } = executive.createPipeline(userId, text);
    let errorOccurred = false;

    try {
      // ── 🧠 Executive Decision ──────────────────────────────────────────
      const decision = await executive.decide(userId, text, sm);
      console.log('[Executive] 📋 Decision: tier=' + decision.tier +
        ' | provider=' + decision.provider +
        ' | needs=' + JSON.stringify(decision.needs) +
        ' | wm=' + (decision.workingMemoryActive ? 'active' : 'idle') +
        ' | reason=' + decision.reason +
        ' | trace=' + traceId);

      // ── 📡 Emit intent:detected event ─────────────────────────────────
      eventBus.emitSync(EVENTS.INTENT_DETECTED, {
        userId,
        tier: decision.tier,
        category: decision.category,
        mood: decision.mood,
        language: decision.language,
        provider: decision.provider,
        traceId,
      });

      // ── Build executive context for deep tier ──────────────────────────
      const llmOptions = {};
      if (decision.tier === 'fast') {
        llmOptions.minimal = true; // skip memory/reminders/people
      } else if (decision.tier === 'deep') {
        // Inject working memory + world model into LLM context
        llmOptions.executiveContext = await executive.buildContext(userId, decision, text, sm);
      }

      // ── Inject pending edit context so LLM knows which item to edit ──
      const edit = getPendingEdit(userId);
      if (edit) {
        if (edit.type === 'reminder') {
          text = '✏️ EDITING REMINDER #' + edit.id + ' (' + edit.label + ')\n' +
            'User clicked "Edit" on this reminder. Now they are telling you what to change.\n' +
            'You MUST use update_reminder with reminder_id=' + edit.id + '. Do NOT create a new reminder.\n' +
            'User says: ' + text;
        } else if (edit.type === 'event') {
          text = '✏️ EDITING EVENT #' + edit.id + ' (' + edit.label + ')\n' +
            'User clicked "Edit" on this event. Now they are telling you what to change.\n' +
            'You MUST use update_event with event_id=' + edit.id + '. Do NOT create a new event.\n' +
            'User says: ' + text;
        }
      }

      // 🔥 Use summarized history to prevent context amnesia in long chats
      const history = getEffectiveHistory(userId);

      // ── 🧠 Thinking steps for deep tier — show what the bot is doing ──
      let thinkingMsg = null;
      let thinkingStep = 0;
      const thinkingSteps = decision.tier === 'deep'
        ? ['🔍 Analyzing your request…', '🧠 Loading context & memory…', '📋 Planning approach…']
        : [];

      async function advanceThinking() {
        if (thinkingSteps.length === 0) return;
        if (thinkingStep >= thinkingSteps.length) return;
        const step = thinkingSteps[thinkingStep];
        thinkingStep++;
        try {
          if (!thinkingMsg) {
            thinkingMsg = await bot.sendMessage(chatId, step);
          } else {
            await bot.editMessageText(step, { chat_id: chatId, message_id: thinkingMsg.message_id });
          }
        } catch { /* ignore edit failures */ }
      }

      // Show first thinking step immediately for deep tier
      if (decision.tier === 'deep') await advanceThinking();

      // ── 🔥 ALL tiers now use STREAMING for snappier UX ──────────────────
      let streamMsg = null;
      let streamEditFailed = false;
      let llmResponse;

      llmResponse = await llm.chatStream(userId, text, history, llmOptions, async (displayText) => {
        // Delete thinking message on first real token
        if (thinkingMsg && !streamMsg) {
          try { await bot.deleteMessage(chatId, thinkingMsg.message_id); } catch { }
          thinkingMsg = null;
        }

        // Show second thinking step after first few bytes arrive
        if (decision.tier === 'deep' && thinkingStep === 1 && displayText.length < 20) {
          await advanceThinking().catch(() => { });
        }

        try {
          if (!streamMsg) {
            streamMsg = await bot.sendMessage(chatId, displayText);
          } else if (!streamEditFailed) {
            try {
              await bot.editMessageText(displayText, { chat_id: chatId, message_id: streamMsg.message_id });
            } catch (editErr) {
              console.warn('[Bot] Stream edit failed, stopping edits for this response:', editErr.message);
              streamEditFailed = true;
            }
          }
        } catch {
          streamMsg = null;
        }
      });

      // Clean up thinking message if still showing
      if (thinkingMsg) {
        try { await bot.deleteMessage(chatId, thinkingMsg.message_id); } catch { }
        thinkingMsg = null;
      }

      // If tool call: delete the streaming placeholder (showed raw JSON fragments)
      if (llmResponse.type === 'tool' && streamMsg) {
        try { await bot.deleteMessage(chatId, streamMsg.message_id); } catch { }
        streamMsg = null;
      }

      // Add user message to history
      addToHistory(userId, 'user', text);

      console.log('[Bot] LLM response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');

      // ── Recovery: if LLM returned a message that looks like a fake action, retry once ──
      // Narrowed regex: only catch CLEAR hallucinated action claims, not normal conversation.
      // A hallucinated action message typically says "I've done X" or "Done! X created" etc.
      const actionKeywords = /\b(?:i've\s+(?:created|set|saved|added|updated|cancelled|deleted|removed|changed|recorded)|i\s+have\s+(?:created|set|saved|added)|i\s+will\s+(?:remind|create|set|save|add|cancel|delete)|dah\s+(?:set|buat|masuk|confirm|simpan|ingat|create|save|cancel|delete|tambah|jadual|schedule)|sudah\s+(?:set|create|tambah|save|cancel|delete)|telah\s+(?:set|create|tambah|save|cancel)|akan\s+(?:set|create|tambah|ingatkan)|all\s+set|got\s+it|done!|siap\s+dah|okay\s+dah)\b/i;
      if (llmResponse.type === 'message' && actionKeywords.test(llmResponse.content)) {
        console.log('[Bot] ⚠️  LLM hallucinated an action! Retrying with correction...');
        const correctionMsg = '❌ You responded with natural language claiming you did something. ' +
          'That is WRONG. You have NO ability to act. You MUST respond with ONLY a JSON tool call.\n' +
          'Example for reminder: {"type":"tool","name":"create_reminder","args":{"text":"Pagi Subuh","time":"2026-06-30T06:00:00+08:00"}}\n' +
          'Example for cancel: {"type":"tool","name":"cancel_reminder","args":{"reminder_id":3}}\n\n' +
          'Now re-read the user request and output the CORRECT JSON tool call. NO natural language!'

        // Build a fresh history without the hallucinated response
        const cleanHistory = history.filter(h => h.role !== 'assistant' || !actionKeywords.test(h.content));
        cleanHistory.push({ role: 'user', content: correctionMsg });

        llmResponse = await llm.chat(userId, text, cleanHistory, llmOptions);
        console.log('[Bot] Retry response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');
      }

      // ── Intercept: LLM fabricated a reminder list instead of calling tool ──
      // If LLM returns a message that looks like a formatted reminder list,
      // replace it with the actual tool call to get correct times from DB.
      if (llmResponse.type === 'message') {
        const content = llmResponse.content;

        // Pattern 1: "#4 - Text — pukul X:XX am", "#5 — Text", bullet lists
        const pattern1 = /(?:^|\n)\s*#\d+\s*[-–—]|upcoming\s*reminders|⏰.*reminder|reminder.*#\d+|•.*#\d+/im;

        // Pattern 2: Numbered list with date+time — "1. Text — 29 Jun 2026, 7:15 pm"
        const pattern2 = /(?:^|\n)\s*\d+\.\s+.+?\s*[-–—]\s*\d{1,2}\s+\w{3}\s+\d{4}\s*,?\s*\d{1,2}:\d{2}/im;

        // Pattern 3: Multiple "X. Text — time" format (two or more numbered items)
        const numberedItems = content.match(/(?:^|\n)\s*(\d+)\.\s+.+?[-–—].+?(?:\n|$)/gi);
        const hasMultipleNumberedItems = numberedItems && numberedItems.length >= 2;

        // Pattern 4: Content mentions "reminder" AND has multiple lines with dash-separated times
        const hasReminderWord = /\breminder(s)?\b/i.test(content);
        const timeEntries = content.match(/\d{1,2}[:.]\d{2}\s*(?:am|pm|AM|PM)/g);
        const hasMultipleTimes = timeEntries && timeEntries.length >= 2;

        const looksLikeReminderList =
          pattern1.test(content) ||
          pattern2.test(content) ||
          hasMultipleNumberedItems ||
          (hasReminderWord && hasMultipleTimes);

        // Also check: does the message mention multiple #numbers (like #4, #5)?
        const hashIdMatches = content.match(/#(\d+)/g);
        const hasMultipleHashIds = hashIdMatches && hashIdMatches.length >= 2;

        if (looksLikeReminderList || hasMultipleHashIds) {
          console.log('[Bot] ⚠️ LLM hallucinated reminder list! Replacing with real list_reminders tool call.');
          console.log('[Bot]    Detected by: pattern1=' + pattern1.test(content) +
            ' pattern2=' + pattern2.test(content) +
            ' numberedItems=' + hasMultipleNumberedItems +
            ' reminderWord+times=' + (hasReminderWord && hasMultipleTimes) +
            ' hashIds=' + hasMultipleHashIds);
          llmResponse = { type: 'tool', name: 'list_reminders', args: {} };
        }

        // ── Recovery: LLM acknowledged a search instead of calling web_search ──
        const searchAckPattern = /\b(?:kejap|sekejap|tunggu|search dulu|cari dulu|check dulu|cekidout dulu|aku search|aku cari|aku check|let me (?:search|look|check|find|google)|mencari|searching|checking|looking (?:up|for)|nak (?:aku|saya)?\s*(?:search|cari|check)|takut.*aku.*update)/i;
        const userSearchIntentPattern = /\b(?:siapa|apa|bila|mana|berapa|cari|search|check|find|look\s*up|berita|news|terkini|latest|cuaca|weather|harga|price|stock|crypto|pm\s*malaysia|perdana\s*menteri)/i;

        if (searchAckPattern.test(content) && userSearchIntentPattern.test(text)) {
          console.log('[Bot] ⚠️ LLM acknowledged search but didn\'t call web_search! Forcing search...');
          console.log('[Bot]    LLM said:', content.slice(0, 150));
          console.log('[Bot]    User asked:', text.slice(0, 150));

          // Extract a clean search query from the user's original text
          let searchQuery = text
            .replace(/^(?:tolong\s+)?(?:cari|search|check|find|look\s*up)\s+/i, '')
            .replace(/\b(?:aku|saya|i|you|tolong|please|boleh\s+(?:tak|kah)?|can\s+you|nak\s+(?:tau|tahu)?)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

          // If query is too short after cleanup, use the original text
          if (searchQuery.length < 3) searchQuery = text;

          console.log('[Bot]    Search query:', searchQuery);
          llmResponse = { type: 'tool', name: 'web_search', args: { query: searchQuery } };
        }
      }

      if (llmResponse.type === 'message') {
        // Plain response — WARNING: no DB action occurs here
        // ⏰ Guard: fix any hallucinated time before sending
        llmResponse.content = fixHallucinatedGreeting(llmResponse.content);
        llmResponse.content = fixHallucinatedTime(llmResponse.content);
        console.log('[Bot] Message response (no tool executed):', llmResponse.content.slice(0, 150));
        addToHistory(userId, 'assistant', llmResponse.content);
        stopTyping();
        await safeSendMessage(bot, chatId, llmResponse.content);

        // ── 📡 Emit message:sent event ───────────────────────────────────
        eventBus.emitSync(EVENTS.MESSAGE_SENT, {
          userId,
          chatId,
          type: 'message',
          content: llmResponse.content.slice(0, 200),
          timestamp: new Date().toISOString(),
        });

        // ── Post-processing guided by executive ──────────────────────────
        const postActions = executive.decidePostProcessing(decision, llmResponse);

        if (postActions.extractFacts) {
          memory.extractFactsFromChat(userId, text, llmResponse.content, llm.chatMimo);
        }
        if (postActions.extractPeople) {
          relationships.extractPeopleFromChat(userId, text, llmResponse.content, llm.chatMimo);
        }
        if (postActions.updateWorkingMemory) {
          executive.workingMemory.update(userId, {
            contextNotes: 'Last exchange: user asked "' + text.slice(0, 100) + '" → bot responded',
          });
        }
        if (postActions.updateDomains) {
          // Fasa 3: Track domain context
          const activeDomain = domains.detectActiveDomain(text);
          executive.worldModel.update(userId, { activeDomain: activeDomain.domain });
        }
        if (postActions.runSelfEval) {
          // Fasa 5: Evaluate response quality
          const quality = executive.evaluator.evaluateResponseQuality({
            userMessage: text,
            botResponse: llmResponse.content,
            tier: decision.tier,
            category: decision.category,
          });
          executive.evaluator.recordInteraction(userId, {
            tier: decision.tier,
            category: decision.category,
            quality: quality.score,
          });

          // ── State machine: response evaluated ──────────────────────────
          executive.transitionResponseEvaluated(sm, {
            qualityScore: quality.score,
            issues: quality.issues,
          });

          if (quality.score < 60) {
            console.log('[Evaluator] ⚠️ Low quality response (score=' + quality.score + '): ' + quality.issues.join('; '));
          }
        }
        if (postActions.suggestProactive && decision.proactiveSuggestion) {
          // Fasa 5: Check if we should send a proactive message later
          console.log('[Proactive] 💡 Suggestion queued: ' + decision.proactiveSuggestion.reason);
        }

        // Track for pattern recognition (always)
        patterns.trackMessage(userId, { role: 'user', content: text });
        patterns.trackMessage(userId, { role: 'assistant', content: llmResponse.content });

        console.log('[Executive] ✅ ' + decision.tier.toUpperCase() + ' path complete | post: facts=' + postActions.extractFacts + ' people=' + postActions.extractPeople + ' wm=' + postActions.updateWorkingMemory + ' domains=' + postActions.updateDomains + ' eval=' + postActions.runSelfEval);

      } else if (llmResponse.type === 'tool') {
        // ── 🔌 Run plugin tool call hooks (before execution) ───────────────
        const interceptResult = await pluginRegistry.runToolCallHooks(
          llmResponse.name, llmResponse.args, userId
        );
        if (interceptResult.intercepted) {
          console.log('[Bot] 🔌 Tool call intercepted by plugin "' + interceptResult.plugin + '"');
          result = interceptResult.result;
        } else {
          // Execute tool
          console.log('[Bot] Executing tool:', llmResponse.name, JSON.stringify(llmResponse.args).slice(0, 200));
          const toolStartMs = Date.now();
          try {
            result = await tools.executeTool(userId, {
              name: llmResponse.name,
              args: llmResponse.args,
            });
            const toolDurationMs = Date.now() - toolStartMs;
            console.log('[Bot] Tool result:', typeof result === 'object' ? (result.type || 'object') : result.slice(0, 150));

            // 📡 Emit tool:executed event
            eventBus.emitSync(EVENTS.TOOL_EXECUTED, {
              userId,
              toolName: llmResponse.name,
              args: llmResponse.args,
              success: true,
              durationMs: toolDurationMs,
            });

            // Log tool call for observability
            trace.logToolCall(llmResponse.name, llmResponse.args, result, toolDurationMs);
          } catch (toolErr) {
            console.error('[Bot] Tool execution error:', toolErr.message);

            // 📡 Emit tool:failed event
            eventBus.emitSync(EVENTS.TOOL_FAILED, {
              userId,
              toolName: llmResponse.name,
              args: llmResponse.args,
              error: toolErr.message,
            });

            trace.logToolCall(llmResponse.name, llmResponse.args, { error: toolErr.message }, Date.now() - toolStartMs);
            result = 'I tried to do that but ran into a problem. Please try again.';
          }
        }

        // ── State machine: tools executed ────────────────────────────────
        executive.transitionToolsExecuted(sm, {
          toolName: llmResponse.name,
          toolSuccess: !(result && result.error),
        });

        // ── Confirmation flow: if tool returned {type:'confirm', message} ──
        if (result && typeof result === 'object' && result.type === 'confirm') {
          // ⏰ Guard: fix any hallucinated times in the confirm message
          result.message = fixHallucinatedGreeting(result.message);
          result.message = fixHallucinatedTime(result.message);
          addToHistory(userId, 'assistant', result.message);
          try {
            await bot.sendMessage(chatId, result.message, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Ya', callback_data: 'confirm_config' },
                  { text: '❌ Batal', callback_data: 'cancel_config' },
                ]],
              },
            });
          } catch {
            await bot.sendMessage(chatId, result.message, {
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Ya', callback_data: 'confirm_config' },
                  { text: '❌ Batal', callback_data: 'cancel_config' },
                ]],
              },
            });
          }
          // ── Post-processing guided by executive ──────────────────────────
          const postActions = executive.decidePostProcessing(decision, { type: 'message', content: result.message });

          if (postActions.extractFacts) {
            memory.extractFactsFromChat(userId, text, result.message, llm.chatMimo);
          }
          if (postActions.extractPeople) {
            relationships.extractPeopleFromChat(userId, text, result.message, llm.chatMimo);
          }
          if (postActions.updateWorkingMemory) {
            executive.workingMemory.update(userId, {
              contextNotes: 'Confirm flow: ' + text.slice(0, 100),
            });
          }
          if (postActions.updateDomains) {
            const activeDomain = domains.detectActiveDomain(text);
            executive.worldModel.update(userId, { activeDomain: activeDomain.domain });
          }
          if (postActions.runSelfEval) {
            const quality = executive.evaluator.evaluateResponseQuality({
              userMessage: text,
              botResponse: result.message,
              tier: decision.tier,
              category: decision.category,
            });
            executive.evaluator.recordInteraction(userId, {
              tier: decision.tier,
              category: decision.category,
              quality: quality.score,
            });
          }

          patterns.trackMessage(userId, { role: 'user', content: text });
          patterns.trackMessage(userId, { role: 'assistant', content: result.message });

          // ── 🏁 Finish pipeline (confirm flow exits early) ──────────────
          stopTyping();
          executive.finishPipeline(sm, {
            tier: decision.tier,
            provider: decision.provider,
            responseType: 'confirm',
          });

          return; // Done — wait for user to click button or type "ya"
        }

        // ── Smart Follow-up: after add_note, check if it implies a reminder ──
        let followupResult = null;
        if (llmResponse.name === 'add_note' && llmResponse.args.content) {
          const noteContent = llmResponse.args.content;
          const followupPrompt =
            '📝 The user just saved this note: "' + noteContent + '"\n\n' +
            'YOUR JOB: Determine if this note implies a follow-up task that should become a reminder.\n\n' +
            'Examples that SHOULD create a reminder:\n' +
            '• "follow up with Ali on Friday" → reminder: "Follow up with Ali" on Friday\n' +
            '• "call client tomorrow 3pm" → reminder: "Call client" tomorrow at 3pm\n' +
            '• "send report by Monday" → reminder: "Send report" on Monday\n\n' +
            'Examples that should NOT:\n' +
            '• "React Native looks promising" → no reminder\n' +
            '• "idea for blog post" → no reminder (just an idea)\n' +
            '• "buy groceries" → no specific time, so no reminder\n\n' +
            'If a reminder IS needed, output: {"type":"tool","name":"create_reminder","args":{"text":"...","time":"ISO-8601"}}\n' +
            'If NOT needed, output: {"type":"message","content":"SKIP"}';

          try {
            const followupHistory = [{ role: 'user', content: followupPrompt }];
            const followupResponse = await llm.chatDeepseek(userId, noteContent, followupHistory);
            console.log('[Bot] Follow-up check result:', followupResponse.type, followupResponse.name || '');

            if (followupResponse.type === 'tool' && followupResponse.name === 'create_reminder') {
              followupResult = await tools.executeTool(userId, {
                name: 'create_reminder',
                args: followupResponse.args,
              });
              console.log('[Bot] Smart follow-up reminder created');
            }
          } catch (fuErr) {
            console.warn('[Bot] Smart follow-up check failed (non-fatal):', fuErr.message);
          }
        }

        // ── Web Search: re-summarize results in the user's language via LLM ──
        if (llmResponse.name === 'web_search') {
          try {
            const summarizePrompt =
              '🌐 You just performed a web search for the user. Below are the raw search results.\n\n' +
              'YOUR JOB: Summarize these results in a helpful, concise reply.\n\n' +
              '🚨 CRITICAL LANGUAGE RULE (NON-NEGOTIABLE):\n' +
              '• User wrote in English → reply in English\n' +
              '• User wrote in Bahasa Melayu → reply in Bahasa Melayu\n' +
              '• User wrote rojak (campur BM+English, e.g. "apa news terkini about AI?") → reply rojak juga\n' +
              '• Match the user\'s exact language style and tone. JANGAN tukar bahasa!\n\n' +
              'User\'s original query: "' + text + '"\n\n' +
              '─────────────── RAW SEARCH RESULTS ───────────────\n' +
              (typeof result === 'object' && result.message ? result.message : result) + '\n' +
              '──────────────────────────────────────────────────\n\n' +
              'Now write a natural, friendly reply summarizing these results. ' +
              'Respond with: {"type":"message","content":"your summary here"}';

            const summarizeHistory = [{ role: 'user', content: summarizePrompt }];
            const summaryResponse = await llm.chatMimo(userId, text, summarizeHistory);
            console.log('[Bot] Web search re-summary result:', summaryResponse.type, summaryResponse.content ? summaryResponse.content.slice(0, 150) : '');

            if (summaryResponse.type === 'message' && summaryResponse.content) {
              // 🚫 Guard: if the summary looks like raw JSON (LLM didn't follow format),
              // discard it and use the raw search results instead
              const trimmed = summaryResponse.content.trim();
              if (trimmed.startsWith('{') || trimmed.startsWith('```')) {
                console.warn('[Bot] ⚠️ Web search summary looks like raw JSON, discarding and using raw results');
              } else {
                result = fixHallucinatedGreeting(summaryResponse.content);
                result = fixHallucinatedTime(result);
              }
            }
          } catch (summaryErr) {
            console.warn('[Bot] Web search re-summary failed (using raw results):', summaryErr.message);
          }
        }

        // ── Send result with inline buttons for actionable tool results ──
        const isStructured = result && typeof result === 'object' && result.type === 'result';
        const resultText = isStructured ? result.message : result;

        // ── Clear pending edit after successful update ──
        if (isStructured && (result.tool === 'update_reminder' || result.tool === 'update_event')) {
          clearPendingEdit(userId);
        }
        // If user said something unrelated while editing, clear pending edit
        if (edit && !isStructured) {
          clearPendingEdit(userId);
        }

        // Build final text (with possible follow-up)
        const followupText = followupResult
          ? (typeof followupResult === 'object' && followupResult.message ? followupResult.message : followupResult)
          : null;
        let finalResult = followupText ? resultText + '\n\n' + followupText : resultText;

        // ⏰ NOTE: Do NOT run fixHallucinatedTime on tool results.
        // Tool results contain accurate times from the DB (reminders, events, etc.).
        // fixHallucinatedTime would incorrectly replace those times with the current time.
        addToHistory(userId, 'assistant', finalResult);

        // Determine inline keyboard based on tool type
        let inlineKeyboard = null;
        if (isStructured) {
          switch (result.tool) {
            case 'create_reminder':
            case 'update_reminder':
              inlineKeyboard = [
                [{ text: '✏️ Edit', callback_data: 'edit_reminder:' + result.id }, { text: '❌ Cancel', callback_data: 'cancel_reminder:' + result.id }],
                [{ text: '📋 View All Reminders', callback_data: 'list_reminders' }],
              ];
              break;
            case 'create_event':
            case 'update_event':
              inlineKeyboard = [
                [{ text: '✏️ Edit', callback_data: 'edit_event:' + result.id }, { text: '❌ Cancel', callback_data: 'cancel_event:' + result.id }],
                [{ text: '📅 View Today', callback_data: 'get_today' }],
              ];
              break;
            case 'add_note':
              inlineKeyboard = [
                [{ text: '❌ Delete', callback_data: 'delete_note:' + result.id }],
                [{ text: '📝 View All Notes', callback_data: 'list_notes' }],
              ];
              break;
            case 'set_fact':
              inlineKeyboard = [[
                { text: '❌ Forget', callback_data: 'forget_fact:' + encodeURIComponent(result.meta.key) },
              ]];
              break;
            case 'create_task':
              inlineKeyboard = [
                [{ text: '🚀 Start', callback_data: 'start_task:' + result.id }, { text: '✅ Done', callback_data: 'complete_task:' + result.id }],
                [{ text: '❌ Cancel', callback_data: 'cancel_task:' + result.id }, { text: '📋 All Tasks', callback_data: 'list_tasks' }],
              ];
              break;
            case 'create_goal':
              inlineKeyboard = [
                [{ text: '🏆 Complete', callback_data: 'complete_goal:' + result.id }, { text: '🗑️ Abandon', callback_data: 'abandon_goal:' + result.id }],
                [{ text: '🎯 All Goals', callback_data: 'list_goals' }],
              ];
              break;
            // List results — add contextual quick follow-ups
            case 'list_reminders':
              inlineKeyboard = [[
                { text: '➕ Set New Reminder', callback_data: 'new_reminder' },
              ]];
              break;
            case 'list_tasks':
              inlineKeyboard = [[
                { text: '➕ New Task', callback_data: 'new_task' },
                { text: '🎯 Goals', callback_data: 'list_goals' },
              ]];
              break;
            case 'list_goals':
              inlineKeyboard = [[
                { text: '➕ New Goal', callback_data: 'new_goal' },
                { text: '📋 Tasks', callback_data: 'list_tasks' },
              ]];
              break;
          }
        }

        // Add web_search follow-up button for search results
        if (llmResponse.name === 'web_search') {
          inlineKeyboard = [[
            { text: '📝 Save as Note', callback_data: 'save_search_note:' + encodeURIComponent(text.slice(0, 50)) },
          ]];
        }

        // ── 🔄 Stop typing indicator before showing result ────────────────
        stopTyping();

        if (inlineKeyboard) {
          let keyboardSent = false;
          try {
            await bot.sendMessage(chatId, finalResult, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: inlineKeyboard },
            });
            keyboardSent = true;
          } catch (mdErr) {
            console.error('[Bot] Inline keyboard Markdown send failed: ' + mdErr.message);
            try {
              await bot.sendMessage(chatId, finalResult, {
                reply_markup: { inline_keyboard: inlineKeyboard },
              });
              keyboardSent = true;
            } catch (plainErr) {
              console.error('[Bot] Inline keyboard plain send also failed: ' + plainErr.message);
            }
          }
          // ── Fallback: if keyboard send failed entirely, try without keyboard ──
          if (!keyboardSent) {
            console.log('[Bot] ⚠️ Keyboard send failed, falling back to safeSendMessage without keyboard');
            await safeSendMessage(bot, chatId, finalResult);
          }
        } else {
          await safeSendMessage(bot, chatId, finalResult);
        }

        // ── ✅ Emoji reaction on user's message for tool execution ───────
        if (messageId) {
          try {
            await bot.setMessageReaction(chatId, messageId, {
              reaction: [{ type: 'emoji', emoji: '✅' }],
            });
          } catch {
            // setMessageReaction may not be available on older bot API versions
            // Fallback: silently ignore — reactions are a nice-to-have
          }
        }

        // ── Post-processing guided by executive ──────────────────────────
        const postActions = executive.decidePostProcessing(decision, llmResponse);

        if (postActions.extractFacts) {
          memory.extractFactsFromChat(userId, text, finalResult, llm.chatMimo);
        }
        if (postActions.extractPeople) {
          relationships.extractPeopleFromChat(userId, text, finalResult, llm.chatMimo);
        }
        if (postActions.updateDomains) {
          const activeDomain = domains.detectActiveDomain(text);
          executive.worldModel.update(userId, { activeDomain: activeDomain.domain });
        }
        if (postActions.runSelfEval) {
          const quality = executive.evaluator.evaluateResponseQuality({
            userMessage: text,
            botResponse: finalResult,
            tier: decision.tier,
            category: decision.category,
          });
          executive.evaluator.recordInteraction(userId, {
            tier: decision.tier,
            category: decision.category,
            quality: quality.score,
            toolName: llmResponse.name,
            toolSuccess: true,
          });
        }

        // Track for pattern recognition (always)
        patterns.trackMessage(userId, { role: 'user', content: text });
        patterns.trackMessage(userId, {
          role: 'assistant',
          content: finalResult,
          toolUsed: llmResponse.name,
        });

        console.log('[Executive] ✅ ' + decision.tier.toUpperCase() + ' path complete (tool=' + llmResponse.name + ') | post: facts=' + postActions.extractFacts + ' people=' + postActions.extractPeople + ' wm=' + postActions.updateWorkingMemory + ' domains=' + postActions.updateDomains + ' eval=' + postActions.runSelfEval);

      } else {
        console.log('[Bot] Unknown LLM response type:', llmResponse.type);
        await bot.sendMessage(chatId, 'Something went wrong. Try again?');
      }

      // ── 🏁 Finish pipeline successfully ──────────────────────────────────
      executive.finishPipeline(sm, {
        tier: decision.tier,
        provider: decision.provider,
        responseType: llmResponse.type,
      });

    } catch (err) {
      stopTyping();
      console.error('[Bot] Message handler error:', err.message, err.stack?.split('\n')[1] || '');

      // ── 📡 Emit error:occurred event ───────────────────────────────────
      eventBus.emitSync(EVENTS.ERROR_OCCURRED, {
        source: 'bot:message_handler',
        userId,
        message: text?.slice(0, 100),
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join('\n'),
        timestamp: new Date().toISOString(),
      });

      // ── Record error in state machine ───────────────────────────────────
      if (sm && !errorOccurred) {
        sm.error(err);
      }

      let errorMsg = 'Something went wrong. ';
      if (err.response && err.response.status === 401) {
        errorMsg += 'Check your API key.';
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorMsg += 'Can\'t reach the API. Check your internet connection.';
      } else if (err.response && err.response.status === 400) {
        // Telegram 400 — likely a message formatting issue, but the action likely succeeded
        errorMsg += 'Tapi action tadi mungkin dah jalan. Guna /reminders untuk check.';
      } else if (err.response && err.response.status >= 500) {
        errorMsg += 'Telegram server issue. Please try again in a moment.';
      } else {
        errorMsg += 'Please try again.';
      }
      await safeSendMessage(bot, chatId, errorMsg);
    }
  }

  // ── /recap command — summarize recent conversations ────────────────────
  bot.onText(/\/recap(?:\s+(\d+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    await bot.sendChatAction(chatId, 'typing');

    try {
      const count = Math.min(parseInt(match[1] || '15', 10), 50);
      const history = getHistory(OWNER_ID);

      if (history.length < 3) {
        return bot.sendMessage(chatId, '📭 Not enough conversation history to recap. Chat with me more!');
      }

      // Take the last N messages for summarization
      const recentMessages = history.slice(-count);
      const conversationText = recentMessages
        .map(m => (m.role === 'user' ? '👤' : '🤖') + ' ' + m.content.slice(0, 200))
        .join('\n\n');

      const recapPrompt =
        '📋 Summarize this Telegram chat conversation into a concise recap.\n\n' +
        'Rules:\n' +
        '• Group by topic, not chronologically\n' +
        '• Highlight decisions made, reminders set, and key info shared\n' +
        '• Keep it brief — bullet points preferred\n' +
        '• Match the user\'s language (BM / English / rojak)\n\n' +
        '─────────────── CONVERSATION ───────────────\n' +
        conversationText + '\n' +
        '──────────────────────────────────────────────\n\n' +
        'Respond with: {"type":"message","content":"*📋 Conversation Recap*\n\n...your recap here..."}';

      const recapResponse = await llm.chatMimo(OWNER_ID, 'Recap my conversations', [{ role: 'user', content: recapPrompt }], { minimal: false });

      if (recapResponse.type === 'message' && recapResponse.content) {
        const recap = fixHallucinatedGreeting(recapResponse.content);
        await safeSendMessage(bot, chatId, recap);
      } else {
        await bot.sendMessage(chatId, '❌ Could not generate recap. Try again.');
      }
    } catch (err) {
      console.error('/recap error:', err.message);
      await bot.sendMessage(chatId, '❌ Could not generate recap.');
    }
  });

  // ── Main text message handler ────────────────────────────────────────────
  bot.on('message', async (msg) => {
    // Skip commands (handled above) and non-owner messages
    if (!isOwner(msg)) return;
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;

    const userId = OWNER_ID;
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Owner';
    const text = msg.text.trim().toLowerCase();

    // ── Check for pending config confirmation (text reply) ─────────────────
    const confirmWords = /^(ya|yes|y|ok|okay|confirm|setuju|on|yup|👍)$/i;
    const cancelWords = /^(batal|no|n|tidak|cancel|off|nope|👎)$/i;

    const pending = getPendingConfig(userId);
    if (pending && (confirmWords.test(text) || cancelWords.test(text))) {
      if (confirmWords.test(text)) {
        try {
          const confirmed = await confirmPendingConfig(userId);
          if (!confirmed) {
            await safeSendMessage(bot, chatId, '⏰ No pending change found (may have expired).');
            return;
          }
          // Clear history for name/personality so new style takes effect immediately
          if (confirmed.key === 'bot_name' || confirmed.key === 'bot_personality') {
            clearHistory(userId);
          }
          // Refresh cron if time setting changed
          if (confirmed.envKey === 'MORNING_BRIEFING_TIME' || confirmed.envKey === 'REFLECTION_TIME' || confirmed.envKey === 'WEEKLY_REVIEW_TIME') {
            try {
              if (typeof refreshSchedules === 'function') await refreshSchedules();
            } catch { /* ignore */ }
          }
          await safeSendMessage(bot, chatId, '✅ *' + confirmed.label + ' updated!*\n\n' + escapeMd(confirmed.value));
        } catch (err) {
          console.error('Text confirm error:', err.message);
          await safeSendMessage(bot, chatId, '❌ Failed to update setting.');
        }
      } else {
        removePendingConfig(userId);
        await safeSendMessage(bot, chatId, '❌ Change cancelled.');
      }
      return;
    }

    await processUserText(bot, chatId, userId, userName, msg.text, msg.message_id);
  });

  // ── Voice message handler ────────────────────────────────────────────────
  bot.on('voice', async (msg) => {
    if (!isOwner(msg)) return;

    const userId = OWNER_ID;
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Owner';

    console.log('[Bot] 🎤 Voice message received (duration:', msg.voice.duration + 's)');

    // Check if OpenAI API key is configured
    if (!process.env.OPENAI_API_KEY) {
      await safeSendMessage(bot, chatId,
        '🎤 Voice messages are not set up yet.\n\n' +
        'Add your *OPENAI_API_KEY* to the `.env` file to enable voice transcription with Whisper.'
      );
      return;
    }

    await bot.sendChatAction(chatId, 'typing');

    let tmpPath;
    try {
      // Download the voice file from Telegram
      tmpPath = await downloadVoiceFile(bot, msg.voice.file_id);

      // Transcribe with Whisper
      const transcribedText = await transcribe(tmpPath, 'telegram_bot');

      if (!transcribedText) {
        await bot.sendMessage(chatId, '🎤 I received your voice message but couldn\'t make out any words. Try again?');
        return;
      }

      // Echo the transcription so the user can see what was understood
      await bot.sendMessage(chatId, '🎤 _"' + escapeMd(transcribedText) + '"_', { parse_mode: 'Markdown' });

      // Process the transcribed text through the normal pipeline
      await processUserText(bot, chatId, userId, userName, transcribedText, msg.message_id);

    } catch (err) {
      console.error('[Bot] Voice processing error:', err.message);
      if (err.response && err.response.status === 401) {
        await safeSendMessage(bot, chatId, '🔑 Invalid OpenAI API key. Check your OPENAI_API_KEY in .env');
      } else if (err.message.includes('OPENAI_API_KEY')) {
        await safeSendMessage(bot, chatId, '🎤 Voice transcription is not configured. Add OPENAI_API_KEY to your .env file.');
      } else {
        await safeSendMessage(bot, chatId, '🎤 Sorry, I couldn\'t process that voice message. Please try again or type it out.');
      }
    }
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
  });

  return bot;
}

module.exports = { createBot };
