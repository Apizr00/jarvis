// src/bot/history.js
// ── Conversation History Management ─────────────────────────────────────────
// Manages in-memory conversation history per user with:
//   - DB persistence (loaded on startup, saved on every message)
//   - Automatic summarization when history exceeds threshold
//   - Pending edit tracking (for inline edit workflows)
//   - Message deduplication (skip duplicate messages within 10s)

const db = require('../db');

// ── Conversation History Store ─────────────────────────────────────────────

const conversationHistory = {};
const MAX_HISTORY = 30; // keep last 30 messages (was 20 — too short for context continuity)

/**
 * Load recent chat history from DB into in-memory cache.
 * Called once at bot startup to restore context.
 */
async function loadHistoryFromDB(userId) {
  try {
    const rows = await db.getRecentChatHistory(userId, MAX_HISTORY);
    if (rows.length > 0) {
      conversationHistory[userId] = rows;
      console.log('[History] 📜 Loaded ' + rows.length + ' history messages from DB for user ' + userId);
    }
  } catch (err) {
    console.warn('[History] Could not load chat history from DB:', err.message);
  }
}

function getHistory(userId) {
  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  return conversationHistory[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  // Keep last MAX_HISTORY messages
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  // 💾 Persist to DB (fire-and-forget — don't block the response)
  db.saveChatMessage(userId, role, content).catch(err => {
    console.warn('[History] Failed to persist chat message:', err.message);
  });
}

function clearHistory(userId) {
  delete conversationHistory[userId];
  console.log('[History] 🧹 Cleared conversation history for ' + userId);
}

// ── Pending Edit Tracking ─────────────────────────────────────────────────

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

// ── Summarization ──────────────────────────────────────────────────────────

const SUMMARIZE_THRESHOLD = 25; // summarize when >25 messages (was 15)
const KEEP_RECENT = 18;         // keep last 18 messages (was 12)

function buildTopicSummary(messages) {
  const allMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => m.content);
  if (allMessages.length === 0) return '';

  // Extract meaningful topics using smarter keyword extraction
  // Handles both English AND Malay/BM words (length > 2 for BM words like "doa", "Subuh")
  const topics = [];
  const seen = new Set();

  // Common stop words in both English and Malay
  const stopWords = /^(?:nak|saya|aku|kau|dia|kami|kita|mereka|yang|dengan|pada|untuk|dalam|akan|telah|sudah|boleh|mesti|perlu|juga|sahaja|saja|pun|lagi|dah|ni|tu|ke|tak|kan|lah|nya|ini|itu|ada|tiada|bukan|tidak|ya|dan|atau|the|and|for|with|this|that|from|have|what|when|your|just|like|about|dont|youre|its|ive|ill|was|are|but|not|all|can|get|has|had|been|one|out|some|them|then|now|will|would|could|should|really|very|much|also|only|just|even|still|well|ok|okay|yeah|yes|no|dont|doesnt|isnt|aint|im|you|they|she|he|we|how|why|where|who|when|which|there|here)$/i;

  for (const msg of allMessages) {
    const clean = msg.replace(/[^\w\s@#\-]/g, ' ').replace(/\s+/g, ' ').trim();
    // Allow 2+ char words to capture BM words like "doa", "Subuh", "azan"
    const words = clean.split(' ').filter(w => w.length > 2 && !stopWords.test(w)).slice(0, 8);
    for (const w of words) {
      const lower = w.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        topics.push(w);
        if (topics.length >= 12) break;
      }
    }
    if (topics.length >= 12) break;
  }

  // Group related topics into a coherent summary
  return topics.length > 0 ? '[Earlier topics: ' + topics.join(', ') + ']' : '';
}

function getEffectiveHistory(userId) {
  const history = getHistory(userId);
  if (history.length <= SUMMARIZE_THRESHOLD) return history;

  const firstMsg = history[0];
  const alreadySummarized = firstMsg && firstMsg.role === 'system' &&
    /^\[Earlier/.test(firstMsg.content);

  if (alreadySummarized) {
    const recent = history.slice(-KEEP_RECENT);
    return [firstMsg, ...recent];
  }

  const older = history.slice(0, history.length - KEEP_RECENT);
  const summary = buildTopicSummary(older);
  const recent = history.slice(-KEEP_RECENT);

  if (summary) {
    const newHistory = [{ role: 'system', content: summary }, ...recent];
    conversationHistory[userId] = newHistory;
    console.log('[History] 📝 Summarized ' + older.length + ' older messages → ' + summary.slice(0, 150));
    return newHistory;
  }

  // If no summary generated, just trim to MAX_HISTORY
  const trimmed = history.slice(-MAX_HISTORY);
  conversationHistory[userId] = trimmed;
  return trimmed;
}

// ── Message Deduplication ─────────────────────────────────────────────────

const recentUserMessages = new Map();

function isDuplicateUserMessage(userId, text) {
  const entry = recentUserMessages.get(userId);
  if (!entry) return false;
  if (entry.text === text && Date.now() - entry.timestamp < 10000) {
    return true;
  }
  return false;
}

function cacheUserMessageResponse(userId, text, response) {
  recentUserMessages.set(userId, { text, timestamp: Date.now(), response });
  if (recentUserMessages.size > 50) {
    const cutoff = Date.now() - 30000;
    for (const [k, v] of recentUserMessages) {
      if (v.timestamp < cutoff) recentUserMessages.delete(k);
    }
  }
}

module.exports = {
  loadHistoryFromDB,
  getHistory,
  addToHistory,
  clearHistory,
  getEffectiveHistory,
  // Pending edits
  setPendingEdit,
  getPendingEdit,
  clearPendingEdit,
  // Dedup
  isDuplicateUserMessage,
  cacheUserMessageResponse,
  // Constants
  SUMMARIZE_THRESHOLD,
  KEEP_RECENT,
};
