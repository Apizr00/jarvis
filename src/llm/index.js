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
    const startMs = Date.now();
    const result = await providerFn(userId, userMessage, conversationHistory, providerOpts, context);
    recordLatency(primary, Date.now() - startMs);
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
    const startMs = Date.now();
    const result = await fallbackFn(userId, userMessage, conversationHistory, providerOpts, context);
    recordLatency(fallback, Date.now() - startMs);
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

/**
 * Streaming chat — progressively calls onChunk(displayText) as LLM generates tokens.
 * Falls back to non-streaming chat() if provider doesn't support streaming.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {Array} conversationHistory
 * @param {{provider?:string, minimal?:boolean, executiveContext?:string}} options
 * @param {function} onChunk - callback receiving incremental display text
 * @returns {Promise<{type:string, content?:string, name?:string, args?:object, _provider?:string}>}
 */
async function chatStream(userId, userMessage, conversationHistory, options = {}, onChunk) {
  const { primary, reason } = selectProvider(userMessage, options);

  console.log('[LLM] 🌊 Streaming: ' + primary + ' (reason: ' + reason + ')' +
    (options.minimal ? ' [minimal]' : '') +
    (options.executiveContext ? ' [exec]' : ''));

  const context = await prepareContext(userId, userMessage, options);

  const providerOpts = {
    minimal: options.minimal,
    executiveContext: options.executiveContext,
    maxTokens: options.minimal ? 150 : (options.executiveContext ? 800 : 400),
  };

  const providerFn = primary === 'deepseek' ? deepseek.chatStream : mimo.chatStream;

  try {
    const result = await providerFn(userId, userMessage, conversationHistory, providerOpts, context, onChunk);
    result._provider = primary;
    recordSuccess(primary);
    return result;
  } catch (err) {
    console.warn('[LLM] ⚠️  ' + primary + ' stream failed (' + err.message + '), trying fallback...');
    recordFailure(primary);

    // Fall back to non-streaming
    const fallback = primary === 'deepseek' ? 'mimo' : 'deepseek';
    try {
      const fallbackFn = fallback === 'deepseek' ? deepseek.chat : mimo.chat;
      const result = await fallbackFn(userId, userMessage, conversationHistory, providerOpts, context);
      result._provider = fallback;
      console.log('[LLM] ✅ ' + fallback + ' fallback succeeded');
      recordSuccess(fallback);
      return result;
    } catch (fallbackErr) {
      console.error('[LLM] ❌ Both providers failed:', fallbackErr.message);
      recordFailure(fallback);
      throw new Error('All LLM providers are unavailable.');
    }
  }
}

/** Force MiMo (for extraction, reflection, casual tasks). Falls back to DeepSeek. */
async function chatMimo(userId, userMessage, conversationHistory) {
  return chat(userId, userMessage, conversationHistory, { provider: 'mimo' });
}

/** Force DeepSeek (for tool execution, planning). Falls back to MiMo. */
async function chatDeepseek(userId, userMessage, conversationHistory) {
  return chat(userId, userMessage, conversationHistory, { provider: 'deepseek' });
}

// ── Cost + Latency Optimizer ────────────────────────────────────────────────

// ── Per-provider latency tracking (rolling window) ─────────────────────────
const latencyWindow = new Map(); // provider → [{ms, timestamp}]
const MAX_LATENCY_SAMPLES = 50;
const LATENCY_WINDOW_MS = 30 * 60_000; // 30 minute window

/**
 * Record a provider's response latency.
 */
function recordLatency(provider, ms) {
  if (!latencyWindow.has(provider)) {
    latencyWindow.set(provider, []);
  }
  const window = latencyWindow.get(provider);
  window.push({ ms, timestamp: Date.now() });

  // Prune old entries
  while (window.length > MAX_LATENCY_SAMPLES) window.shift();
  const cutoff = Date.now() - LATENCY_WINDOW_MS;
  while (window.length > 0 && window[0].timestamp < cutoff) window.shift();
}

/**
 * Get average and p95 latency for a provider.
 */
function getLatencyStats(provider) {
  const window = latencyWindow.get(provider) || [];
  if (window.length === 0) return { avgMs: 0, p95Ms: 0, count: 0 };

  const times = window.map(e => e.ms).sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const p95Idx = Math.ceil(times.length * 0.95) - 1;

  return {
    avgMs: Math.round(sum / times.length),
    p95Ms: times[p95Idx] || times[times.length - 1],
    minMs: times[0],
    maxMs: times[times.length - 1],
    count: times.length,
  };
}

// ── Token Estimation ────────────────────────────────────────────────────────

/**
 * Estimate token count for a string.
 * Rough heuristic: ~1.3 tokens per word for English, ~2 for mixed/BM.
 * Used for cost estimation before making API calls.
 *
 * @param {string} text
 * @returns {number} estimated token count
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const words = text.split(/\s+/).length;
  const chars = text.length;
  // Blend word-count and char-count based estimates
  return Math.ceil(Math.max(words * 1.3, chars / 4));
}

/**
 * Estimate the total token cost for a chat call.
 * @param {string} userMessage
 * @param {Array} conversationHistory
 * @param {string} systemPrompt
 * @param {string} provider - 'deepseek' or 'mimo'
 * @returns {{inputTokens: number, estimatedOutputTokens: number, estimatedCostUSD: number}}
 */
function estimateCost(userMessage, conversationHistory, systemPrompt, provider, maxTokens) {
  // Input tokens
  const historyText = (conversationHistory || []).map(m => m.content || '').join(' ');
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(historyText) + estimateTokens(userMessage);

  // Output tokens (use maxTokens as ceiling)
  const outputTokens = Math.min(maxTokens || 800, 800);

  // Cost per 1M tokens (approximate, as of 2026)
  const pricing = {
    deepseek: { input: 0.27, output: 1.10 },  // DeepSeek V3 pricing
    mimo: { input: 0.15, output: 0.60 },       // MiMo estimated pricing
  };

  const p = pricing[provider] || pricing.mimo;
  const cost = (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;

  return {
    inputTokens: Math.ceil(inputTokens),
    estimatedOutputTokens: outputTokens,
    estimatedCostUSD: Math.round(cost * 1_000_000) / 1_000_000, // round to 6 decimal places
  };
}

// ── Timeout Budget per Tier ─────────────────────────────────────────────────

/**
 * Get the timeout budget (in ms) for a given execution tier.
 * Fast tier should respond quickly; deep tier gets more time.
 */
function getTimeoutBudget(tier) {
  switch (tier) {
    case 'fast': return 4_000;   // 4 seconds — greetings must be snappy
    case 'medium': return 10_000;  // 10 seconds — conversation
    case 'deep': return 20_000;  // 20 seconds — complex reasoning + tools
    default: return 12_000;
  }
}

// ── Latency-Aware Provider Selection ────────────────────────────────────────

/**
 * Select the best provider considering latency, cost, and task complexity.
 * Extends the basic `selectProvider` with latency-awareness.
 *
 * Strategy:
 *   - Fast tier: prefer the provider with lower avg latency
 *   - Medium tier: prefer cheaper provider unless it's slow
 *   - Deep tier: prefer stronger model unless it's in cooldown
 *
 * @param {string} userMessage
 * @param {{provider?: string, minimal?: boolean, executiveContext?: string}} options
 * @returns {{primary: string, reason: string, estimatedCostUSD: number}}
 */
function selectProviderOptimized(userMessage, options = {}) {
  // First, use the base selection logic
  const base = selectProvider(userMessage, options);
  const intent = detectIntent(userMessage);
  const tier = intent.tier;

  const deepseekLatency = getLatencyStats('deepseek');
  const mimoLatency = getLatencyStats('mimo');

  // ── Fast tier: prefer faster provider ──────────────────────────────────
  if (tier === 'fast') {
    // If MiMo is known to be fast and available, use it
    if (!isInCooldown('mimo') && mimoLatency.avgMs > 0 && deepseekLatency.avgMs > 0) {
      if (mimoLatency.avgMs < deepseekLatency.avgMs) {
        return { primary: 'mimo', reason: 'fast tier — mimo is faster (' + mimoLatency.avgMs + 'ms vs ' + deepseekLatency.avgMs + 'ms)', estimatedCostUSD: 0 };
      }
    }
    // Default: MiMo for fast (cheaper)
    if (!isInCooldown('mimo')) {
      return { primary: 'mimo', reason: 'fast tier — cheaper provider', estimatedCostUSD: 0 };
    }
    return { primary: 'deepseek', reason: 'fast tier — mimo in cooldown', estimatedCostUSD: 0 };
  }

  // ── Medium tier: cost-aware selection ──────────────────────────────────
  if (tier === 'medium') {
    // If MiMo latency is acceptable (< 5s avg), use it (cheaper)
    if (!isInCooldown('mimo') && (mimoLatency.avgMs === 0 || mimoLatency.avgMs < 5000)) {
      return { primary: 'mimo', reason: 'medium tier — mimo cost-effective (' + (mimoLatency.avgMs || '?') + 'ms avg)', estimatedCostUSD: 0 };
    }
    // MiMo too slow or in cooldown → DeepSeek
    if (!isInCooldown('deepseek')) {
      return { primary: 'deepseek', reason: 'medium tier — mimo too slow/in cooldown', estimatedCostUSD: 0 };
    }
    return { primary: 'mimo', reason: 'medium tier — deepseek in cooldown', estimatedCostUSD: 0 };
  }

  // ── Deep tier: prefer strongest model ──────────────────────────────────
  if (!isInCooldown('deepseek')) {
    return { primary: 'deepseek', reason: 'deep tier — strongest model', estimatedCostUSD: 0 };
  }
  return { primary: 'mimo', reason: 'deep tier — deepseek in cooldown, fallback', estimatedCostUSD: 0 };
}

/**
 * Get a summary of LLM usage stats for /status.
 */
function getUsageStats() {
  const ds = getLatencyStats('deepseek');
  const mm = getLatencyStats('mimo');

  return {
    deepseek: {
      latency: ds,
      health: { ...healthState.deepseek, inCooldown: isInCooldown('deepseek') },
    },
    mimo: {
      latency: mm,
      health: { ...healthState.mimo, inCooldown: isInCooldown('mimo') },
    },
    totalCalls: (ds.count || 0) + (mm.count || 0),
  };
}

module.exports = {
  chat, chatStream, chatMimo, chatDeepseek, detectIntent, getProviderHealth,
  // Cost + Latency optimizer
  estimateTokens,
  estimateCost,
  getTimeoutBudget,
  getLatencyStats,
  recordLatency,
  selectProviderOptimized,
  getUsageStats,
};
