// src/llm/index.js
// LLM Router — Load balanced with automatic fallback
//
// Provider selection:
//   'ilmu'      → primary ILMU (fast BM chat), fallback MiMo → DeepSeek
//   'deepseek'  → primary DeepSeek, fallback MiMo → ILMU
//   'mimo'      → primary MiMo, fallback ILMU → DeepSeek
//   'auto'      → intent-based routing (fast/medium → ILMU, deep → DeepSeek)
//   (default)   → same as 'auto'
//
// Each route always has cascade fallback — if the chosen provider fails,
// the next one takes over automatically.

const deepseek = require('./deepseek');
const mimo = require('./mimo');
const ilmu = require('./ilmu');
const { detectIntent } = require('./intent');
const db = require('../db');
const memory = require('../memory');
const relationships = require('../memory/relationships');

// ── Provider Health Tracking ────────────────────────────────────────────────
// Track recent failures so we can temporarily deprioritize a flaky provider.

const healthState = {
  ilmu: { failures: 0, lastFailure: 0, cooldownUntil: 0 },
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
 * @param {{provider?: 'ilmu'|'deepseek'|'mimo'|'auto'}} options
 * @returns {{primary: 'ilmu'|'deepseek'|'mimo', reason: string}}
 */
function selectProvider(userMessage, options = {}) {
  const preferred = options.provider || 'auto';

  // Explicit provider overrides — use it unless in cooldown
  if (preferred === 'ilmu') {
    if (isInCooldown('ilmu')) {
      if (!isInCooldown('mimo')) return { primary: 'mimo', reason: 'ilmu in cooldown, using mimo' };
      return { primary: 'deepseek', reason: 'ilmu+mimo in cooldown, using deepseek' };
    }
    return { primary: 'ilmu', reason: 'explicit ilmu' };
  }

  if (preferred === 'deepseek') {
    if (isInCooldown('deepseek')) {
      if (!isInCooldown('ilmu')) return { primary: 'ilmu', reason: 'deepseek in cooldown, using ilmu' };
      return { primary: 'mimo', reason: 'deepseek+ilmu in cooldown, using mimo' };
    }
    return { primary: 'deepseek', reason: 'explicit deepseek' };
  }

  if (preferred === 'mimo') {
    if (isInCooldown('mimo')) {
      if (!isInCooldown('ilmu')) return { primary: 'ilmu', reason: 'mimo in cooldown, using ilmu' };
      return { primary: 'deepseek', reason: 'mimo+ilmu in cooldown, using deepseek' };
    }
    return { primary: 'mimo', reason: 'explicit mimo' };
  }

  // ── Auto: intent-based routing ─────────────────────────────────────────
  //   fast/medium → ILMU mini (cheapest + best BM)
  //   deep        → DeepSeek (best function calling)
  const intent = detectIntent(userMessage);

  if (intent.tier === 'deep') {
    if (isInCooldown('deepseek')) {
      if (!isInCooldown('mimo')) return { primary: 'mimo', reason: 'deep task but deepseek in cooldown' };
      return { primary: 'ilmu', reason: 'deep task — deepseek+mimo in cooldown, fallback ilmu' };
    }
    return { primary: 'deepseek', reason: intent.reason };
  }

  // Fast or medium → ILMU mini (cheapest, best BM)
  if (isInCooldown('ilmu')) {
    if (!isInCooldown('mimo')) return { primary: 'mimo', reason: intent.reason + ' but ilmu in cooldown' };
    return { primary: 'deepseek', reason: intent.reason + ' — ilmu+mimo in cooldown' };
  }
  return { primary: 'ilmu', reason: intent.reason + ' (ilmu-mini)' };
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
 * Get the provider module by name.
 * @param {'ilmu'|'deepseek'|'mimo'} name
 * @returns {{chat: Function, chatStream: Function}}
 */
function getProviderFn(name) {
  switch (name) {
    case 'ilmu': return ilmu;
    case 'deepseek': return deepseek;
    case 'mimo': return mimo;
    default: return ilmu; // default to cheapest
  }
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
  // Cascade fallback chain: ilmu → mimo → deepseek (or deepseek → ilmu → mimo)
  const fallbackChain = primary === 'deepseek'
    ? ['ilmu', 'mimo']
    : primary === 'ilmu'
      ? ['mimo', 'deepseek']
      : ['ilmu', 'deepseek'];

  console.log('[LLM] 🎯 Routing: ' + primary + ' (reason: ' + reason + ')' +
    (options.minimal ? ' [minimal]' : '') +
    (options.executiveContext ? ' [exec]' : ''));

  // 🔥 Pre-fetch context ONCE (parallel DB calls) — shared by all providers
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
    const providerFn = getProviderFn(primary).chat;
    const startMs = Date.now();
    const result = await providerFn(userId, userMessage, conversationHistory, providerOpts, context);
    recordLatency(primary, Date.now() - startMs);
    result._provider = primary;
    recordSuccess(primary);
    return result;
  } catch (primaryErr) {
    console.warn('[LLM] ⚠️  ' + primary + ' failed (' + primaryErr.message + '), falling back...');
    recordFailure(primary);
  }

  // ── Try fallback chain (reuses same pre-fetched context!) ──────────────
  for (const fb of fallbackChain) {
    try {
      const fbFn = getProviderFn(fb).chat;
      const startMs = Date.now();
      const result = await fbFn(userId, userMessage, conversationHistory, providerOpts, context);
      recordLatency(fb, Date.now() - startMs);
      result._provider = fb;
      console.log('[LLM] ✅ ' + fb + ' fallback succeeded');
      recordSuccess(fb);
      return result;
    } catch (fbErr) {
      console.warn('[LLM] ⚠️  ' + fb + ' fallback also failed:', fbErr.message);
      recordFailure(fb);
    }
  }

  console.error('[LLM] ❌ All providers exhausted.');
  throw new Error('All LLM providers are unavailable. Please try again later.');
}

/**
 * Get current health state of providers (for /status).
 */
function getProviderHealth() {
  return {
    ilmu: { ...healthState.ilmu, inCooldown: isInCooldown('ilmu') },
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

  const providerFn = getProviderFn(primary).chatStream;

  try {
    const result = await providerFn(userId, userMessage, conversationHistory, providerOpts, context, onChunk);
    result._provider = primary;
    recordSuccess(primary);
    return result;
  } catch (err) {
    console.warn('[LLM] ⚠️  ' + primary + ' stream failed (' + err.message + '), trying fallback...');
    recordFailure(primary);

    // Fall back to non-streaming with cascade
    const fallbackChain = primary === 'deepseek'
      ? ['ilmu', 'mimo']
      : primary === 'ilmu'
        ? ['mimo', 'deepseek']
        : ['ilmu', 'deepseek'];

    for (const fb of fallbackChain) {
      try {
        const fbFn = getProviderFn(fb).chat;
        const result = await fbFn(userId, userMessage, conversationHistory, providerOpts, context);
        result._provider = fb;
        console.log('[LLM] ✅ ' + fb + ' fallback succeeded');
        recordSuccess(fb);
        return result;
      } catch (fbErr) {
        console.warn('[LLM] ⚠️  ' + fb + ' fallback also failed:', fbErr.message);
        recordFailure(fb);
      }
    }

    console.error('[LLM] ❌ All providers exhausted on stream fallback.');
    throw new Error('All LLM providers are unavailable.');
  }
}

/** Force ILMU (for casual chat, BM conversations). Falls back MiMo → DeepSeek. */
async function chatIlmu(userId, userMessage, conversationHistory) {
  return chat(userId, userMessage, conversationHistory, { provider: 'ilmu' });
}

/** Force MiMo (for extraction, reflection, casual tasks). Falls back ILMU → DeepSeek. */
async function chatMimo(userId, userMessage, conversationHistory) {
  return chat(userId, userMessage, conversationHistory, { provider: 'mimo' });
}

/** Force DeepSeek (for tool execution, planning). Falls back ILMU → MiMo. */
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

  // Cost per 1M tokens (approximate, as of 2026, converted to USD)
  const pricing = {
    ilmu: { input: 0.05, output: 0.27 },        // ILMU mini ~RM 0.20/1.20 → ~$0.05/0.27
    deepseek: { input: 0.27, output: 1.10 },     // DeepSeek V3 pricing
    mimo: { input: 0.15, output: 0.60 },          // MiMo estimated pricing
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

  const ilmuLatency = getLatencyStats('ilmu');
  const deepseekLatency = getLatencyStats('deepseek');
  const mimoLatency = getLatencyStats('mimo');

  // ── Fast tier: prefer ILMU mini (cheapest, best BM) ────────────────────
  if (tier === 'fast') {
    if (!isInCooldown('ilmu')) {
      return { primary: 'ilmu', reason: 'fast tier — ilmu-mini (cheapest)', estimatedCostUSD: 0 };
    }
    if (!isInCooldown('mimo')) {
      return { primary: 'mimo', reason: 'fast tier — ilmu in cooldown, fallback mimo', estimatedCostUSD: 0 };
    }
    return { primary: 'deepseek', reason: 'fast tier — ilmu+mimo in cooldown', estimatedCostUSD: 0 };
  }

  // ── Medium tier: cost-aware selection ──────────────────────────────────
  if (tier === 'medium') {
    // ILMU mini is cheapest, use if available and latency acceptable
    if (!isInCooldown('ilmu') && (ilmuLatency.avgMs === 0 || ilmuLatency.avgMs < 5000)) {
      return { primary: 'ilmu', reason: 'medium tier — ilmu-mini cost-effective (' + (ilmuLatency.avgMs || '?') + 'ms avg)', estimatedCostUSD: 0 };
    }
    // Fallback to MiMo
    if (!isInCooldown('mimo') && (mimoLatency.avgMs === 0 || mimoLatency.avgMs < 5000)) {
      return { primary: 'mimo', reason: 'medium tier — mimo (ilmu slow/cooldown)', estimatedCostUSD: 0 };
    }
    // Last resort DeepSeek
    if (!isInCooldown('deepseek')) {
      return { primary: 'deepseek', reason: 'medium tier — ilmu+mimo unavailable', estimatedCostUSD: 0 };
    }
    return { primary: 'ilmu', reason: 'medium tier — all others in cooldown', estimatedCostUSD: 0 };
  }

  // ── Deep tier: prefer strongest model ──────────────────────────────────
  if (!isInCooldown('deepseek')) {
    return { primary: 'deepseek', reason: 'deep tier — strongest model', estimatedCostUSD: 0 };
  }
  if (!isInCooldown('mimo')) {
    return { primary: 'mimo', reason: 'deep tier — deepseek in cooldown', estimatedCostUSD: 0 };
  }
  return { primary: 'ilmu', reason: 'deep tier — deepseek+mimo in cooldown, fallback ilmu', estimatedCostUSD: 0 };
}

/**
 * Get a summary of LLM usage stats for /status.
 */
function getUsageStats() {
  const il = getLatencyStats('ilmu');
  const ds = getLatencyStats('deepseek');
  const mm = getLatencyStats('mimo');

  return {
    ilmu: {
      latency: il,
      health: { ...healthState.ilmu, inCooldown: isInCooldown('ilmu') },
    },
    deepseek: {
      latency: ds,
      health: { ...healthState.deepseek, inCooldown: isInCooldown('deepseek') },
    },
    mimo: {
      latency: mm,
      health: { ...healthState.mimo, inCooldown: isInCooldown('mimo') },
    },
    totalCalls: (il.count || 0) + (ds.count || 0) + (mm.count || 0),
  };
}

module.exports = {
  chat, chatStream, chatIlmu, chatMimo, chatDeepseek, detectIntent, getProviderHealth,
  // Cost + Latency optimizer
  estimateTokens,
  estimateCost,
  getTimeoutBudget,
  getLatencyStats,
  recordLatency,
  selectProviderOptimized,
  getUsageStats,
};
