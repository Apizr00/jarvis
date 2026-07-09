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

const SUMMARIZE_THRESHOLD = 25; // summarize when >25 messages
const KEEP_RECENT = 18;         // keep last 18 messages
const SMART_SUMMARIZE_AT = 20;  // trigger LLM summary at 20+ messages

// Cache for LLM-generated summaries (avoids re-summarizing same history)
const summaryCache = new Map(); // userId → { summary, messageCount, timestamp }

/**
 * Generate a smart LLM-powered summary of conversation history.
 * Runs asynchronously — call after response is sent (fire-and-forget).
 * Uses the cheap ILMU-mini model so it doesn't slow things down.
 *
 * @param {string} userId
 * @param {Array} messages - the messages to summarize
 * @param {Function} llmChatFn - LLM chat function (e.g., llm.chatMimo or llm.chatIlmu)
 */
async function generateSmartSummary(userId, messages, llmChatFn) {
  if (!llmChatFn || messages.length < 5) return;

  // Skip if we already have a recent summary for roughly the same message count
  const cached = summaryCache.get(userId);
  if (cached && Math.abs(cached.messageCount - messages.length) < 5 &&
    Date.now() - cached.timestamp < 5 * 60 * 1000) {
    return; // cached summary is still fresh
  }

  try {
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => (m.role === 'user' ? 'User' : 'Bot') + ': ' + m.content.slice(0, 200))
      .join('\n');

    const prompt =
      'Summarize this conversation in 3-5 concise bullet points. Capture key topics, decisions, actions taken, and context. ' +
      'Write in the same mix of languages as the conversation (BM/English/rojak). Be brief but preserve meaning.\n\n' +
      'CONVERSATION:\n' + conversationText + '\n\n' +
      'SUMMARY (3-5 bullets):';

    const resp = await Promise.race([
      llmChatFn(userId, prompt, [{ role: 'user', content: prompt }]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Summary timeout')), 8000)),
    ]);

    const summaryText = resp?.content || resp?.type === 'message' ? resp.content : '';
    if (summaryText && summaryText.length > 10) {
      summaryCache.set(userId, {
        summary: '[Conversation so far: ' + summaryText.replace(/\n/g, ' | ') + ']',
        messageCount: messages.length,
        timestamp: Date.now(),
      });
      console.log('[History] 🧠 Smart summary generated (' + summaryText.length + ' chars)');
    }
  } catch (err) {
    console.log('[History] Smart summary skipped:', err.message);
  }
}

/**
 * Get the cached smart summary if available and fresh.
 */
function getSmartSummary(userId) {
  const cached = summaryCache.get(userId);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
    return cached.summary;
  }
  return null;
}

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

/**
 * Get effective history for LLM context.
 * Uses smart summaries when available, falls back to keyword extraction.
 * Applies relevance-based pruning to keep only the most context-relevant messages.
 *
 * @param {string} userId
 * @param {string} [currentQuery] - optional current user message for relevance scoring
 */
function getEffectiveHistory(userId, currentQuery) {
  const history = getHistory(userId);
  if (history.length <= SUMMARIZE_THRESHOLD) return history;

  // Check if already has a system summary at position 0
  const firstMsg = history[0];
  const hasSummary = firstMsg && firstMsg.role === 'system' &&
    /^\[(?:Earlier|Conversation)/.test(firstMsg.content);

  // Try smart summary first (LLM-generated, semantically rich)
  const smartSummary = getSmartSummary(userId);
  const summaryText = smartSummary || (hasSummary ? firstMsg.content : buildTopicSummary(
    history.slice(0, history.length - KEEP_RECENT)
  ));

  // Get recent messages
  let recent;
  if (hasSummary) {
    recent = history.slice(-KEEP_RECENT);
  } else {
    recent = history.slice(-KEEP_RECENT);
  }

  // ── Relevance-based pruning ──────────────────────────────────────────
  // If we have a current query AND enough history, prune less relevant messages
  if (currentQuery && recent.length > 12) {
    recent = pruneByRelevance(recent, currentQuery, 12);
  }

  const result = [{ role: 'system', content: summaryText }, ...recent];
  conversationHistory[userId] = result;

  if (smartSummary) {
    console.log('[History] 🧠 Using smart summary + ' + recent.length + ' recent msgs');
  } else {
    console.log('[History] 📝 Keyword summary + ' + recent.length + ' recent msgs');
  }

  return result;
}

/**
 * Prune history to keep only messages relevant to the current query.
 * Always keeps the last 3 messages (immediate context).
 * Scores remaining messages by keyword overlap with the query.
 *
 * @param {Array} messages - recent messages to prune
 * @param {string} query - current user query
 * @param {number} keepCount - how many messages to keep total
 * @returns {Array} pruned messages
 */
function pruneByRelevance(messages, query, keepCount) {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  if (queryWords.length === 0) return messages.slice(-keepCount);

  // Always keep last 3 messages (immediate context)
  const tail = messages.slice(-3);
  const rest = messages.slice(0, -3);

  if (rest.length === 0) return tail;

  // Score each older message by relevance
  const scored = rest.map((msg, idx) => {
    const content = (msg.content || '').toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      if (content.includes(word)) score += 2;
      // Boost if message was close in time (higher index = more recent)
      score += (idx / rest.length) * 0.5;
    }
    return { msg, score, idx };
  });

  // Sort by relevance, take top (keepCount - 3)
  scored.sort((a, b) => b.score - a.score);
  const topRelevant = scored.slice(0, keepCount - 3)
    .sort((a, b) => a.idx - b.idx) // restore chronological order
    .map(s => s.msg);

  const pruned = [...topRelevant, ...tail];
  console.log('[History] 🔍 Pruned ' + messages.length + '→' + pruned.length + ' msgs (relevance-based)');
  return pruned;
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
  // Smart summarization
  generateSmartSummary,
  getSmartSummary,
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
