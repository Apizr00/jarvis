// src/llm/index.js
// LLM Router — Load balanced with automatic fallback
//
// Provider selection:
//   'deepseek'   → primary DeepSeek, fallback MiMo
//   'mimo'       → primary MiMo, fallback DeepSeek
//   'auto'       → intent-based routing (fast/medium → MiMo, deep → DeepSeek)
//   (default)    → same as 'auto'
//
// Each route always has bidirectional fallback — if the chosen provider fails,
// the other one takes over automatically.

const deepseek = require('./deepseek');
const mimo = require('./mimo');
const { detectIntent } = require('./intent');
const db = require('../db');
const memory = require('../memory');
const relationships = require('../memory/relationships');

// ── Provider Health Tracking ────────────────────────────────────────────────
// Track recent failures so we can temporarily deprioritize a flaky provider.

const healthState = {
  deepseek: { failures: 0, lastFailure: 0, cooldownUntil: 0 },
  mimo: { failures: 0, lastFailure: 0, cooldownUntil: 0 },
};

const COOLDOWN_MS = 60_000;       // 1 minute cooldown after 3 failures
const FAILURE_THRESHOLD = 3;      // consecutive failures before cooldown
const HEALTH_RESET_MS = 300_000;  // reset failure count after 5 min of success

/**
 * Check if a provider is currently in cooldown (too many recent failures).
 */
function isInCooldown(provider) {
  const h = healthState[provider];
  if (!h) return false;
  if (Date.now() < h.cooldownUntil) return true;
  // Cooldown expired — reset
  if (h.cooldownUntil > 0) {
    h.cooldownUntil = 0;
    h.failures = 0;
  }
  return false;
}

/**
 * Record a successful call — reset failure count.
 */
function recordSuccess(provider) {
  const h = healthState[provider];
  if (!h) return;
  // Reset if enough time has passed
  if (Date.now() - h.lastFailure > HEALTH_RESET_MS) {
    h.failures = 0;
  }
}

/**
 * Record a failed call — increment failure count, maybe trigger cooldown.
 */
function recordFailure(provider) {
  const h = healthState[provider];
  if (!h) return;
  h.failures++;
  h.lastFailure = Date.now();
  if (h.failures >= FAILURE_THRESHOLD) {
    h.cooldownUntil = Date.now() + COOLDOWN_MS;
    console.warn('[LLM] 🔴 ' + provider + ' entered cooldown (' + h.failures + ' consecutive failures)');
  }
}

/**
 * Determine the best provider based on options and intent.
 * @param {string} userMessage
 * @param {{provider?: 'deepseek'|'mimo'|'auto'}} options
 * @returns {{primary: 'deepseek'|'mimo', reason: string}}
 */
function selectProvider(userMessage, options = {}) {
  const preferred = options.provider || 'auto';

  // Explicit provider override — use it unless in cooldown
  if (preferred === 'deepseek') {
    if (isInCooldown('deepseek')) {
      return { primary: 'mimo', reason: 'deepseek in cooldown, using mimo' };
    }
    return { primary: 'deepseek', reason: 'explicit deepseek' };
  }

  if (preferred === 'mimo') {
    if (isInCooldown('mimo')) {
      return { primary: 'deepseek', reason: 'mimo in cooldown, using deepseek' };
    }
    return { primary: 'mimo', reason: 'explicit mimo' };
  }

  // ── Auto: intent-based routing ─────────────────────────────────────────
  const intent = detectIntent(userMessage);

  if (intent.tier === 'deep') {
    // Deep tasks → DeepSeek (better function calling)
    if (isInCooldown('deepseek')) {
      return { primary: 'mimo', reason: 'deep task but deepseek in cooldown' };
    }
    return { primary: 'deepseek', reason: intent.reason };
  }

  // Fast or medium → MiMo (cheaper, good enough for conversation)
  if (isInCooldown('mimo')) {
    return { primary: 'deepseek', reason: intent.reason + ' but mimo in cooldown' };
  }
  return { primary: 'mimo', reason: intent.reason };
}

/**
 * Pre-fetch context (facts, reminders, people) ONCE for both providers.
 * Runs DB calls in parallel for speed. Skips when minimal mode is active.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {{minimal?: boolean}} options
 * @returns {{facts:Array, upcomingReminders:Array, peopleContext:string}}
 */
async function prepareContext(userId, userMessage, options = {}) {
  if (options.minimal) {
    return { facts: [], upcomingReminders: [], peopleContext: '' };
  }

  const [facts, upcomingReminders, peopleContext] = await Promise.all([
    memory.searchFacts(userId, userMessage),
    db.getUpcomingReminders(userId, 15),
    relationships.getPeopleContext(userId, userMessage, 5),
  ]);

  // Record fact access for importance scoring
  memory.recordFactAccess(userId, facts.map(f => f.key));

  return { facts, upcomingReminders, peopleContext };
}

/**
 * Chat with the LLM.
 * Supports provider selection with automatic fallback.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {Array} conversationHistory
 * @param {{provider?: 'deepseek'|'mimo'|'auto', minimal?: boolean, executiveContext?: string}} [options]
 * @returns {Promise<{type:string, content?:string, name?:string, args?:object, _provider?:string}>}
 */
async function chat(userId, userMessage, conversationHistory, options = {}) {
  const { primary, reason } = selectProvider(userMessage, options);
  const fallback = primary === 'deepseek' ? 'mimo' : 'deepseek';

  console.log('[LLM] 🎯 Routing: ' + primary + ' (reason: ' + reason + ')' +
    (options.minimal ? ' [minimal]' : '') +
    (options.executiveContext ? ' [exec]' : ''));

  // 🔥 Pre-fetch context ONCE (parallel DB calls) — shared by both providers
  const context = await prepareContext(userId, userMessage, options);

  // ⚡ Dynamic max_tokens by intent tier — smaller = faster LLM response
  let maxTokens = 800; // default deep
  if (options.minimal) {
    maxTokens = 150; // fast tier: greetings, simple Qs
  } else if (!options.executiveContext) {
    maxTokens = 400; // medium tier: conversation
  }

  const providerOpts = {
    minimal: options.minimal,
    executiveContext: options.executiveContext,
    maxTokens,
  };

  // ── Try primary provider ─────────────────────────────────────────────────
  try {
    const providerFn = primary === 'deepseek' ? deepseek.chat : mimo.chat;
    const result = await providerFn(userId, userMessage, conversationHistory, providerOpts, context);
    result._provider = primary;
    recordSuccess(primary);
    return result;
  } catch (primaryErr) {
    console.warn('[LLM] ⚠️  ' + primary + ' failed (' + primaryErr.message + '), trying ' + fallback + '...');
    recordFailure(primary);
  }

  // ── Try fallback provider (reuses same pre-fetched context!) ───────────
  try {
    const fallbackFn = fallback === 'deepseek' ? deepseek.chat : mimo.chat;
    const result = await fallbackFn(userId, userMessage, conversationHistory, providerOpts, context);
    result._provider = fallback;
    console.log('[LLM] ✅ ' + fallback + ' fallback succeeded');
    recordSuccess(fallback);
    return result;
  } catch (fallbackErr) {
    console.error('[LLM] ❌ Both providers failed. ' + fallback + ' error:', fallbackErr.message);
    recordFailure(fallback);
    throw new Error('All LLM providers are unavailable. Please try again later.');
  }
}

/**
 * Get current health state of providers (for /status).
 */
function getProviderHealth() {
  return {
    deepseek: { ...healthState.deepseek, inCooldown: isInCooldown('deepseek') },
    mimo: { ...healthState.mimo, inCooldown: isInCooldown('mimo') },
  };
}

// ── Convenience wrappers ────────────────────────────────────────────────────

/** Force MiMo (for extraction, reflection, casual tasks). Falls back to DeepSeek. */
async function chatMimo(userId, userMessage, conversationHistory) {
  return chat(userId, userMessage, conversationHistory, { provider: 'mimo' });
}

/** Force DeepSeek (for tool execution, planning). Falls back to MiMo. */
async function chatDeepseek(userId, userMessage, conversationHistory) {
  return chat(userId, userMessage, conversationHistory, { provider: 'deepseek' });
}

module.exports = { chat, chatMimo, chatDeepseek, detectIntent, getProviderHealth };
