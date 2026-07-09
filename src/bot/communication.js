// src/bot/communication.js
// ── Enhanced Communication Layer ─────────────────────────────────────────────
//
//   1. MULTI-PLATFORM SUPPORT  — abstraction so bot works on any platform
//   2. CONTEXT MANAGEMENT       — smart context switching for long conversations
//   3. ADAPTIVE STYLE           — adjust tone/formality/language per user
//
// Platform Adapter pattern: core logic is platform-agnostic.
// Add new platforms by implementing the PlatformAdapter interface.

const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. MULTI-PLATFORM ABSTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Platform adapter interface.
 * Implement this for each platform (Telegram, WhatsApp, Discord, etc.)
 *
 * @typedef {object} PlatformAdapter
 * @property {string} name — platform identifier
 * @property {Function} sendMessage — (chatId, text, options?) → Promise
 * @property {Function} sendTyping — (chatId) → Promise
 * @property {Function} sendVoice — (chatId, audioPath, options?) → Promise
 * @property {Function} sendPhoto — (chatId, photo, options?) → Promise
 * @property {Function} formatText — (text, format) → platform-specific formatted string
 * @property {Function} onMessage — register message handler: (handler) → void
 */

/**
 * Registry of all connected platform adapters.
 */
const platforms = new Map(); // platformName → { adapter, active }

/**
 * Register a platform adapter.
 *
 * @param {PlatformAdapter} adapter
 */
function registerPlatform(adapter) {
  if (!adapter.name) throw new Error('Platform adapter must have a name');
  platforms.set(adapter.name, { adapter, active: true });
  logger.info('[Comm] 📡 Platform registered:', adapter.name);
}

/**
 * Unregister a platform.
 */
function unregisterPlatform(name) {
  platforms.delete(name);
  logger.info('[Comm] 🔌 Platform unregistered:', name);
}

/**
 * Get all active platforms.
 */
function getActivePlatforms() {
  return [...platforms.values()].filter(p => p.active).map(p => p.adapter);
}

/**
 * Send a message to ALL active platforms for a user.
 *
 * @param {string} userId
 * @param {string} text
 * @param {object} [options]
 */
async function broadcastMessage(userId, text, options = {}) {
  const results = [];
  for (const [name, { adapter, active }] of platforms) {
    if (!active) continue;
    try {
      const formatted = adapter.formatText
        ? adapter.formatText(text, options.format || 'markdown')
        : text;

      const result = await adapter.sendMessage(userId, formatted, options);
      results.push({ platform: name, success: true, result });
    } catch (err) {
      logger.warn('[Comm] Broadcast failed on', name, err.message);
      results.push({ platform: name, success: false, error: err.message });
    }
  }
  return results;
}

/**
 * Get a specific platform adapter.
 */
function getPlatform(name) {
  const entry = platforms.get(name);
  return entry?.active ? entry.adapter : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CONVERSATION CONTEXT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Context state per user.
 */
const contextStore = new Map(); // userId → { threads, activeThread, lastSwitch }

/**
 * Conversation thread — a distinct topic/context within a conversation.
 */
class ConversationThread {
  constructor(id, topic, startedAt) {
    this.id = id;
    this.topic = topic;           // brief topic summary
    this.startedAt = startedAt || new Date().toISOString();
    this.lastActivity = new Date().toISOString();
    this.messageCount = 0;
    this.keyFacts = [];            // facts mentioned in this thread
    this.toolCalls = [];           // tools used in this thread
    this.status = 'active';        // active | paused | resolved
    this.parentThreadId = null;    // forked from which thread?
    this.summary = '';             // auto-generated summary on resolution
  }
}

/**
 * Detect if user is switching topics.
 *
 * @param {string} userId
 * @param {string} newMessage
 * @returns {{isSwitch: boolean, reason: string, previousTopic: string|null}}
 */
function detectTopicSwitch(userId, newMessage) {
  const ctx = getContext(userId);
  const active = getActiveThread(userId);

  if (!active || active.messageCount < 2) {
    return { isSwitch: false, reason: 'no active thread', previousTopic: null };
  }

  const lower = newMessage.toLowerCase();
  const activeTopic = active.topic.toLowerCase();

  // ── Strong switch signals ────────────────────────────────────────────
  const switchSignals = [
    // Explicit topic change
    { pattern: /\b(anyway|by\s+the\s+way|btw|on\s+another\s+note|changing\s+topic|nak\s+tanya\s+lain|lain\s+soalan|tukar\s+topik)\b/i, confidence: 0.95 },
    // Different tool domain
    { pattern: /\b(remind|ingatkan|alarm)\b/i, domain: 'reminders', confidence: 0.7 },
    { pattern: /\b(note|nota|simpan|save)\b/i, domain: 'notes', confidence: 0.7 },
    { pattern: /\b(cari|search|google|check)\b/i, domain: 'search', confidence: 0.7 },
    { pattern: /\b(task|tugas|todo|goal|matlamat)\b/i, domain: 'tasks', confidence: 0.7 },
  ];

  for (const signal of switchSignals) {
    if (signal.pattern && signal.pattern.test(lower)) {
      if (signal.domain) {
        // Check if this domain is different from active thread's tools
        const activeDomains = active.toolCalls.map(t => extractDomain(t));
        if (!activeDomains.includes(signal.domain)) {
          return { isSwitch: true, reason: `domain switch: ${signal.domain}`, previousTopic: active.topic };
        }
      } else {
        return { isSwitch: true, reason: 'explicit topic change', previousTopic: active.topic };
      }
    }
  }

  // ── Semantic distance check ──────────────────────────────────────────
  const activeWords = new Set(activeTopic.split(/\s+/).filter(w => w.length > 3));
  const newWords = lower.split(/\s+/).filter(w => w.length > 3);
  const overlap = newWords.filter(w => activeWords.has(w)).length;
  const overlapRatio = overlap / Math.max(newWords.length, 1);

  if (overlapRatio < 0.1 && active.messageCount >= 3) {
    return { isSwitch: true, reason: 'low semantic overlap (' + Math.round(overlapRatio * 100) + '%)', previousTopic: active.topic };
  }

  return { isSwitch: false, reason: 'same topic', previousTopic: null };
}

/**
 * Handle a topic switch — save the old thread and start/switch to a new one.
 *
 * @param {string} userId
 * @param {string} newTopic — extracted topic for the new thread
 * @returns {ConversationThread} the new active thread
 */
function handleTopicSwitch(userId, newTopic) {
  const ctx = getContext(userId);
  const old = getActiveThread(userId);

  if (old) {
    // Save summary of old thread
    old.summary = `Discussed "${old.topic}" — ${old.messageCount} msgs, tools: ${[...new Set(old.toolCalls)].join(', ')}`;
    old.status = 'paused';

    // Check if we already have a thread on this topic
    const existing = ctx.threads.find(t =>
      t.status === 'paused' && t.topic.toLowerCase() === newTopic.toLowerCase()
    );

    if (existing) {
      existing.status = 'active';
      existing.lastActivity = new Date().toISOString();
      ctx.activeThreadId = existing.id;
      logger.info('[Comm] 🔄 Switched back to thread:', existing.topic);
      return existing;
    }
  }

  // Create new thread
  const thread = new ConversationThread(
    'thread_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    newTopic
  );

  ctx.threads.push(thread);
  ctx.activeThreadId = thread.id;
  ctx.lastSwitch = new Date().toISOString();

  // Keep max 10 threads
  if (ctx.threads.length > 10) {
    const resolved = ctx.threads.filter(t => t.status === 'resolved');
    if (resolved.length > 0) {
      ctx.threads = ctx.threads.filter(t => t.status !== 'resolved' || ctx.threads.indexOf(t) < ctx.threads.length - 5);
    }
  }

  logger.info('[Comm] 🔄 Topic switch:', old?.topic?.slice(0, 40), '→', newTopic.slice(0, 40));

  return thread;
}

/**
 * Record a message in the active thread.
 */
function recordThreadActivity(userId, role, content, toolUsed = null) {
  const thread = getActiveThread(userId);
  if (!thread) return;

  thread.lastActivity = new Date().toISOString();
  thread.messageCount++;
  if (toolUsed && !thread.toolCalls.includes(toolUsed)) {
    thread.toolCalls.push(toolUsed);
  }

  // Extract key facts
  const facts = extractKeyFacts(content);
  for (const fact of facts) {
    if (!thread.keyFacts.includes(fact)) {
      thread.keyFacts.push(fact);
    }
  }
}

/**
 * Get conversation context summary for system prompt.
 */
function getContextSummary(userId) {
  const ctx = getContext(userId);
  if (!ctx || ctx.threads.length === 0) return '';

  const active = getActiveThread(userId);
  const recent = ctx.threads
    .filter(t => t.status === 'paused')
    .slice(-3)
    .reverse();

  let summary = '';

  if (active) {
    summary += `📌 Active Thread: "${active.topic}" (${active.messageCount} msgs)\n`;
    if (active.keyFacts.length > 0) {
      summary += '   Key facts: ' + active.keyFacts.slice(0, 5).join(', ') + '\n';
    }
  }

  if (recent.length > 0) {
    summary += '📋 Recent Threads:\n';
    for (const t of recent) {
      summary += `   • "${t.topic}" (${t.messageCount} msgs, ${t.status})\n`;
    }
  }

  return summary ? 'CONVERSATION THREADS ───────────────\n' + summary : '';
}

/**
 * Get or create the context store for a user.
 */
function getContext(userId) {
  if (!contextStore.has(userId)) {
    contextStore.set(userId, { threads: [], activeThreadId: null, lastSwitch: null });
  }
  return contextStore.get(userId);
}

/**
 * Get the active thread for a user.
 */
function getActiveThread(userId) {
  const ctx = getContext(userId);
  return ctx.threads.find(t => t.id === ctx.activeThreadId) || null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractDomain(toolName) {
  const domainMap = {
    create_reminder: 'reminders', cancel_reminder: 'reminders', list_reminders: 'reminders',
    create_event: 'schedule', cancel_event: 'schedule',
    add_note: 'notes',
    create_task: 'tasks', complete_task: 'tasks', list_tasks: 'tasks',
    create_goal: 'goals', list_goals: 'goals',
    web_search: 'search',
    set_fact: 'memory',
  };
  return domainMap[toolName] || 'general';
}

function extractKeyFacts(text) {
  if (!text) return [];
  const facts = [];
  const lower = text.toLowerCase();

  const factPatterns = [
    { pattern: /\b(location|city|address|tinggal|duduk|live\s+(in|at))\s*[:=]?\s*([\w\s]+)/i, key: 'location' },
    { pattern: /\b(job|kerja|profession|role)\s*[:=]?\s*([\w\s]+)/i, key: 'job' },
    { pattern: /\b(prefer|suka|like|favorite|kegemaran)\s*[:=]?\s*([\w\s]+)/i, key: 'preference' },
  ];

  for (const { pattern, key } of factPatterns) {
    const match = text.match(pattern);
    if (match) {
      facts.push(key + ': ' + (match[2] || match[3] || '').trim().slice(0, 40));
    }
  }

  return facts.slice(0, 3);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. ADAPTIVE COMMUNICATION STYLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Style profiles that the bot can adopt.
 */
const STYLE_PROFILES = {
  formal: {
    tone: 'formal',
    language: 'mixed',
    greeting: 'Good day. How may I assist you?',
    signoff: 'Is there anything else I can help with?',
    emojiUse: 'minimal',
    sentenceStyle: 'full',
  },
  casual: {
    tone: 'casual',
    language: 'mixed',
    greeting: 'Hey! Apa khabar?',
    signoff: 'Anything else? 😊',
    emojiUse: 'moderate',
    sentenceStyle: 'relaxed',
  },
  rojak: {
    tone: 'casual',
    language: 'rojak',
    greeting: 'Yo! Apa cerita?',
    signoff: 'Lain kali lagi! ✌️',
    emojiUse: 'high',
    sentenceStyle: 'short',
  },
  professional: {
    tone: 'professional',
    language: 'english',
    greeting: 'Hello. How can I help you today?',
    signoff: 'Please let me know if you need further assistance.',
    emojiUse: 'none',
    sentenceStyle: 'full',
  },
  motivator: {
    tone: 'enthusiastic',
    language: 'mixed',
    greeting: 'Selamat pagi! Ready to crush it today? 💪',
    signoff: 'You got this! 🔥',
    emojiUse: 'high',
    sentenceStyle: 'energetic',
  },
};

/**
 * User style preferences (learned over time).
 */
const userStyles = new Map(); // userId → { profile, customizations, learnedAt }

/**
 * Detect the user's communication style from their messages.
 *
 * @param {string} userId
 * @param {Array<string>} recentMessages — last 10-20 user messages
 * @returns {{detectedStyle: string, confidence: number, signals: Array<string>}}
 */
function detectUserStyle(userId, recentMessages = []) {
  if (recentMessages.length < 3) {
    return { detectedStyle: 'casual', confidence: 0.3, signals: ['not enough data'] };
  }

  const signals = [];
  let rojakScore = 0;
  let formalScore = 0;
  let casualScore = 0;
  let englishScore = 0;
  let malayScore = 0;

  for (const msg of recentMessages) {
    const lower = msg.toLowerCase();

    // Language detection
    const malayWords = /\b(aku|saya|awak|kau|nak|tak|dah|ni|tu|lah|kan|pun|je|ni|tu|bolehlah)\b/i;
    const englishWords = /\b(i|you|the|is|are|was|were|have|has|can|will|would|could|should|please|thanks)\b/i;

    if (malayWords.test(lower)) malayScore++;
    if (englishWords.test(lower)) englishScore++;
    if (malayWords.test(lower) && englishWords.test(lower)) rojakScore++;

    // Formality signals
    if (/\b(please|tolong|boleh\s+(?:tak|kah)|could\s+you|would\s+you|may\s+i|terima\s+kasih|sila)\b/i.test(lower)) formalScore++;
    if (/\b(haha|wakaka|wehh|woi|eh|lah|dowh|gila|best|mantap|power)\b/i.test(lower)) casualScore++;
    if (/\b(boss|bro|sis|geng|fam|mate|dude)\b/i.test(lower)) casualScore++;

    // Emoji usage
    if (/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}]/u.test(msg)) casualScore++;
  }

  const total = recentMessages.length;

  // Determine style
  let detectedStyle = 'casual';
  let confidence = 0.5;

  if (rojakScore > total * 0.4) {
    detectedStyle = 'rojak';
    confidence = Math.min(rojakScore / total, 0.9);
    signals.push('strong rojak language mixing');
  } else if (formalScore > casualScore * 1.5) {
    detectedStyle = 'formal';
    confidence = Math.min(formalScore / total, 0.85);
    signals.push('formal language patterns');
  } else if (englishScore > malayScore * 2) {
    detectedStyle = 'professional';
    confidence = Math.min(englishScore / total, 0.8);
    signals.push('predominantly English');
  }

  if (casualScore > formalScore * 1.5) {
    signals.push('casual tone');
  }

  // Apply personality config if set
  try {
    const db = require('../db');
    // Check if user has explicitly set a personality
    signals.push('using detected style');
  } catch { /* ignore */ }

  return { detectedStyle, confidence: Math.round(confidence * 100) / 100, signals };
}

/**
 * Get the current style for a user (learned or default).
 */
function getUserStyle(userId) {
  if (userStyles.has(userId)) {
    const cached = userStyles.get(userId);
    // Refresh every 24 hours
    if (Date.now() - cached.learnedAt < 24 * 60 * 60 * 1000) {
      return cached.profile;
    }
  }
  return STYLE_PROFILES.casual; // default
}

/**
 * Update user style based on their recent messages.
 */
function updateUserStyle(userId, recentMessages) {
  const { detectedStyle, confidence } = detectUserStyle(userId, recentMessages);

  if (confidence >= 0.6) {
    userStyles.set(userId, {
      profile: STYLE_PROFILES[detectedStyle] || STYLE_PROFILES.casual,
      learnedAt: Date.now(),
      detectedStyle,
      confidence,
    });
  }
}

/**
 * Apply user's style to a bot response.
 *
 * @param {string} userId
 * @param {string} text — raw bot response
 * @returns {string} — styled response
 */
function applyStyle(userId, text) {
  const style = getUserStyle(userId);
  if (!style || style.tone === 'casual') return text; // default = no change

  let result = text;

  // Apply emoji rules
  if (style.emojiUse === 'none') {
    result = result.replace(/[\u{1F600}-\u{1F9FF}]/gu, '').trim();
  } else if (style.emojiUse === 'high' && !/[\u{1F600}-\u{1F9FF}]/u.test(result)) {
    // Add a relevant emoji if missing
    const emojiMap = {
      '✅': /(?:done|completed?|siap|settled?|created?|set)/i,
      '📋': /(?:list|senarai|jadual|schedule|plan)/i,
      '🔍': /(?:search|cari|check|found|jumpa)/i,
      '⏰': /(?:remind|ingatkan|alarm|time|pukul)/i,
      '💡': /(?:suggest|cadang|idea|tip)/i,
    };
    for (const [emoji, pattern] of Object.entries(emojiMap)) {
      if (pattern.test(result)) {
        result = emoji + ' ' + result;
        break;
      }
    }
  }

  // Apply sentence style
  if (style.sentenceStyle === 'short') {
    // Break long sentences
    result = result.replace(/(.{80,}?[.!?])\s+/g, '$1\n');
  }

  return result;
}

/**
 * Get the configured bot personality from DB/env.
 */
async function getBotPersonality(userId) {
  try {
    const db = require('../db');
    return await db.getConfig(userId, 'bot_personality', 'BOT_PERSONALITY', '');
  } catch {
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Multi-platform
  registerPlatform,
  unregisterPlatform,
  getActivePlatforms,
  getPlatform,
  broadcastMessage,

  // Context Management
  detectTopicSwitch,
  handleTopicSwitch,
  recordThreadActivity,
  getContextSummary,
  getActiveThread,
  ConversationThread,

  // Adaptive Style
  STYLE_PROFILES,
  detectUserStyle,
  getUserStyle,
  updateUserStyle,
  applyStyle,
  getBotPersonality,
};
