// src/memory/hierarchy.js
// ── 3-Tier Memory Hierarchy ──────────────────────────────────────────────────
//
//   🔴 SHORT-TERM (STM)  — Last 24 hours, Redis, sub-ms access
//   🟡 WORKING (WM)      — Current conversation, in-process, 2h TTL
//   🟢 LONG-TERM (LTM)   — Compressed, DB-persisted, cross-session
//
// Each tier has different:
//   - Storage backend (Redis / process memory / PostgreSQL)
//   - TTL / retention policy
//   - Retrieval priority (STM checked first, then WM, then LTM)
//   - Compression strategy (none / light / aggressive)
//
// Flow: User asks → check STM → check WM → check LTM → LLM

const db = require('../db');
const redisCache = require('../redis');
const { logger } = require('../utils/logger');

// ── Tier Constants ──────────────────────────────────────────────────────────

const TIERS = Object.freeze({
  SHORT_TERM: 'stm',    // < 24 hours
  WORKING: 'wm',        // current conversation, 2h inactivity
  LONG_TERM: 'ltm',     // > 24 hours, compressed
});

const STM_TTL_SECONDS = 24 * 60 * 60;        // 24 hours
const STM_MAX_ENTRIES = 50;                   // per user
const WM_TTL_MS = 2 * 60 * 60 * 1000;         // 2 hours
const LTM_COMPRESSION_AGE_DAYS = 7;            // compress after 7 days
const LTM_ARCHIVE_AGE_DAYS = 90;               // archive after 90 days

// ── Short-Term Memory (Redis-backed) ────────────────────────────────────────

/**
 * Store a fact/insight in short-term memory.
 * STM is the fastest tier — checked before anything else.
 * 
 * @param {string} userId
 * @param {string} key - fact key
 * @param {string} value - fact value
 * @param {object} [meta] - { confidence, source, tier }
 */
async function stmStore(userId, key, value, meta = {}) {
  try {
    const entry = {
      key,
      value,
      confidence: meta.confidence || 0.7,
      source: meta.source || 'conversation',
      timestamp: Date.now(),
    };

    const stmKey = `jarvis:stm:${userId}`;
    const pipe = redisCache.redis.pipeline();

    // Add to sorted set (scored by timestamp for recency ordering)
    pipe.zadd(stmKey, entry.timestamp, JSON.stringify(entry));
    // Trim to max entries (keep most recent)
    pipe.zremrangebyrank(stmKey, 0, -(STM_MAX_ENTRIES + 1));
    // Set TTL
    pipe.expire(stmKey, STM_TTL_SECONDS);

    await pipe.exec();
  } catch (err) {
    logger.warn('[Memory] STM store failed (non-critical)', { error: err.message });
  }
}

/**
 * Retrieve facts from short-term memory matching a query.
 * Returns most recent first.
 * 
 * @param {string} userId
 * @param {string} query - search query
 * @param {number} [limit=10]
 * @returns {Promise<Array<{key, value, confidence, timestamp, score:number}>>}
 */
async function stmRetrieve(userId, query, limit = 10) {
  try {
    const stmKey = `jarvis:stm:${userId}`;
    // Get all entries (newest first: zrevrange)
    const raw = await redisCache.redis.zrevrange(stmKey, 0, -1);
    if (!raw || raw.length === 0) return [];

    const entries = raw.map(r => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    // Score each entry against the query
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    const scored = entries.map(entry => {
      let score = 0;
      const keyLower = (entry.key || '').toLowerCase();
      const valueLower = (entry.value || '').toLowerCase();

      // Keyword matching
      for (const word of queryWords) {
        if (keyLower.includes(word)) score += 3;
        if (valueLower.includes(word)) score += 2;
      }

      // Confidence boost
      score += (entry.confidence || 0.5) * 2;

      // Recency boost (newer = higher)
      const ageMinutes = (Date.now() - entry.timestamp) / 60000;
      if (ageMinutes < 30) score += 3;
      else if (ageMinutes < 120) score += 2;
      else if (ageMinutes < 360) score += 1;

      return { ...entry, score };
    });

    // Filter and sort
    return scored
      .filter(e => e.score > 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

  } catch (err) {
    logger.warn('[Memory] STM retrieve failed', { error: err.message });
    return [];
  }
}

/**
 * Mark a conversation exchange in STM for session tracking.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {string} botResponse
 */
async function stmRecordExchange(userId, userMessage, botResponse) {
  const topic = extractBriefTopic(userMessage);
  if (topic) {
    await stmStore(userId, `exchange:${Date.now()}`, topic, {
      confidence: 0.5,
      source: 'exchange',
    });
  }
}

// ── Working Memory Bridge (persists WM to Redis for cross-process sharing) ──

/**
 * Snapshot working memory to Redis so it survives process restarts.
 *
 * @param {string} userId
 * @param {object} wmState - the working memory state object
 */
async function wmPersist(userId, wmState) {
  try {
    const key = `jarvis:wm:${userId}`;
    const payload = {
      ...wmState,
      persistedAt: Date.now(),
    };
    await redisCache.redis.set(key, JSON.stringify(payload), 'EX', Math.ceil(WM_TTL_MS / 1000));
  } catch (err) {
    logger.warn('[Memory] WM persist failed', { error: err.message });
  }
}

/**
 * Restore working memory from Redis (after process restart).
 *
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function wmRestore(userId) {
  try {
    const key = `jarvis:wm:${userId}`;
    const raw = await redisCache.redis.get(key);
    if (!raw) return null;

    const wm = JSON.parse(raw);
    const age = Date.now() - wm.persistedAt;

    // Don't restore if older than WM TTL
    if (age > WM_TTL_MS) {
      await redisCache.redis.del(key);
      return null;
    }

    return wm;
  } catch (err) {
    return null;
  }
}

// ── Long-Term Memory (DB-persisted, compressed) ─────────────────────────────

/**
 * Retrieve facts from long-term memory with tier-aware scoring.
 * LTM facts get a baseline score, boosted by recency and importance.
 *
 * @param {string} userId
 * @param {string} query
 * @param {number} [limit=15]
 * @returns {Promise<Array>}
 */
async function ltmRetrieve(userId, query, limit = 15) {
  // Delegate to the existing searchFacts but with tier metadata
  const memory = require('./index');
  const facts = await memory.searchFacts(userId, query, limit);

  // Tag each fact with its memory tier based on age and importance
  const now = Date.now();
  return facts.map(f => {
    const ageDays = f.created_at
      ? (now - new Date(f.created_at).getTime()) / (24 * 60 * 60 * 1000)
      : 0;

    let ltmTier;
    if (ageDays < 1) ltmTier = 'recent';
    else if (ageDays < 7) ltmTier = 'active';
    else if (ageDays < 30) ltmTier = 'consolidated';
    else ltmTier = 'archived';

    return { ...f, ltmTier, ageDays: Math.round(ageDays) };
  });
}

/**
 * Compress long-term memory by summarizing older, related facts.
 * Uses LLM to merge facts when possible, preserving key info.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.olderThanDays=7] - only compress facts older than this
 * @param {boolean} [options.dryRun=false] - if true, report without executing
 * @returns {Promise<{compressed: number, summary: string}>}
 */
async function ltmCompress(userId, options = {}) {
  const { olderThanDays = LTM_COMPRESSION_AGE_DAYS, dryRun = false } = options;

  // Get all facts
  const allFacts = await db.getAllFacts(userId);
  if (allFacts.length === 0) return { compressed: 0, summary: 'No facts to compress.' };

  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const memory = require('./index');

  // ── Step 1: Group facts by domain ────────────────────────────────────
  const domains = require('./domains');
  const grouped = {};

  for (const fact of allFacts) {
    const age = fact.created_at ? Date.now() - new Date(fact.created_at).getTime() : 0;
    if (age < cutoff) continue; // skip recent facts

    const domain = domains.classifyFactDomain(fact.key);
    const domainName = domain.domain || 'general';

    if (!grouped[domainName]) grouped[domainName] = [];
    grouped[domainName].push(fact);
  }

  // ── Step 2: For each domain with >= 3 old facts, create a summary fact ──
  let compressed = 0;
  const summaries = [];

  for (const [domain, facts] of Object.entries(grouped)) {
    if (facts.length < 3) continue;

    // Extract key-value pairs
    const kvPairs = facts.map(f => `${f.key}: ${f.value}`).join('; ');
    const summaryKey = `_ltm_summary:${domain}`;
    const summaryValue = `[Compressed ${facts.length} facts] ${kvPairs}`.slice(0, 500);

    const importance = Math.round(facts.reduce((sum, f) => sum + (f.importance || 5), 0) / facts.length);

    if (!dryRun) {
      // Store the compressed summary
      await db.setFact(userId, summaryKey, summaryValue);
      await db.updateFactMeta(userId, summaryKey, {
        importance: Math.min(importance, 8), // cap importance for summaries
        confidence: 0.6, // lower confidence for compressed facts
      });

      // Delete the original facts (keep the summary)
      for (const fact of facts) {
        if (fact.importance >= 9) continue; // never delete critical facts
        await db.deleteFact(userId, fact.key);
      }

      compressed += facts.filter(f => f.importance < 9).length;
    } else {
      compressed += facts.filter(f => f.importance < 9).length;
    }

    summaries.push(`${domain}: ${facts.length} facts → 1 summary (${facts.filter(f => f.importance >= 9).length} critical preserved)`);
  }

  // Invalidate cache
  if (!dryRun && compressed > 0) {
    await redisCache.invalidateFactsCache(userId);
  }

  return {
    compressed,
    summary: summaries.length > 0
      ? `Compressed ${compressed} facts across ${summaries.length} domains:\n${summaries.map(s => '  • ' + s).join('\n')}`
      : `No compression needed — all facts are recent or already summarized.`,
  };
}

// ── Unified Memory Retrieval (all tiers) ────────────────────────────────────

/**
 * Retrieve facts from ALL memory tiers, deduplicated and merged.
 * Check order: STM → WM → LTM
 * 
 * @param {string} userId
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit=15]
 * @param {string} [options.activeDomain] - domain context for scoring boost
 * @param {string} [options.conversationFlow] - flow hint for context
 * @returns {Promise<{facts: Array, fromTiers: Array<string>, contextual: boolean}>}
 */
async function unifiedRetrieve(userId, query, options = {}) {
  const { limit = 15, activeDomain, conversationFlow } = options;
  const allFacts = [];
  const fromTiers = [];
  const seenKeys = new Set();

  // ── Tier 1: Short-term memory (fastest) ──────────────────────────────
  if (query) {
    const stmFacts = await stmRetrieve(userId, query, 5);
    for (const f of stmFacts) {
      if (!seenKeys.has(f.key)) {
        seenKeys.add(f.key);
        allFacts.push({ ...f, _tier: 'stm' });
      }
    }
    if (stmFacts.length > 0) fromTiers.push('stm');
  }

  // ── Tier 2: Working memory (in-process context) ──────────────────────
  // WM facts are injected via the executive's buildContext, not here.
  // This tier is handled by working-memory.js directly.

  // ── Tier 3: Long-term memory (DB) ────────────────────────────────────
  try {
    const ltmFacts = await ltmRetrieve(userId, query, limit);
    for (const f of ltmFacts) {
      if (!seenKeys.has(f.key)) {
        seenKeys.add(f.key);
        allFacts.push({ ...f, _tier: 'ltm' });
      }
    }
    if (ltmFacts.length > 0) fromTiers.push('ltm');
  } catch (err) {
    logger.warn('[Memory] LTM retrieve failed, falling back to basic search', { error: err.message });
    // Fallback: basic search
    const memory = require('./index');
    const basicFacts = await memory.searchFacts(userId, query, limit);
    for (const f of basicFacts) {
      if (!seenKeys.has(f.key)) {
        seenKeys.add(f.key);
        allFacts.push({ ...f, _tier: 'ltm-fallback' });
      }
    }
  }

  // ── Contextual boosting ──────────────────────────────────────────────
  let contextual = false;
  if (activeDomain || conversationFlow) {
    contextual = true;
    for (const fact of allFacts) {
      const domains = require('./domains');

      // Domain boost
      if (activeDomain) {
        const factDomain = domains.classifyFactDomain(fact.key);
        if (factDomain.domain === activeDomain) {
          fact._contextBoost = (fact._contextBoost || 0) + 5;
        }
        // Related domain boost
        const related = domains.getRelatedDomains(activeDomain);
        if (related[factDomain.domain]) {
          fact._contextBoost = (fact._contextBoost || 0) + related[factDomain.domain] * 3;
        }
      }

      // Conversation flow boost
      if (conversationFlow) {
        const flowDomainMap = {
          planning_trip: 'personal',
          debugging: 'work',
          learning_session: 'learning',
          project_work: 'work',
          meeting_prep: 'work',
          health_journey: 'health',
          morning_routine: 'schedule',
          shopping: 'finance',
        };
        const flowDomain = flowDomainMap[conversationFlow];
        if (flowDomain) {
          const factDomain = domains.classifyFactDomain(fact.key);
          if (factDomain.domain === flowDomain) {
            fact._contextBoost = (fact._contextBoost || 0) + 4;
          }
        }
      }
    }

    // Re-sort with context boosts
    allFacts.sort((a, b) => {
      const aScore = (a._contextBoost || 0) + (a.score || 0);
      const bScore = (b._contextBoost || 0) + (b.score || 0);
      return bScore - aScore;
    });
  }

  return {
    facts: allFacts.slice(0, limit),
    fromTiers,
    contextual,
  };
}

// ── Cross-Session Learning ──────────────────────────────────────────────────

/**
 * Detect session boundaries and save session summary.
 * Called at conversation start and end.
 *
 * @param {string} userId
 * @param {'start'|'end'} boundary
 * @param {object} [wmState] - current working memory (on end)
 */
async function trackSessionBoundary(userId, boundary, wmState = null) {
  const key = `jarvis:session:${userId}`;

  if (boundary === 'start') {
    // Check if last session ended > 30 min ago
    const lastEndRaw = await redisCache.redis.get(`${key}:last_end`);
    const lastEnd = lastEndRaw ? parseInt(lastEndRaw) : 0;
    const gap = Date.now() - lastEnd;

    if (gap > 30 * 60 * 1000) {
      // New session
      const sessionId = `session:${Date.now()}`;
      await redisCache.redis.set(`${key}:current`, sessionId);
      await redisCache.redis.set(`${key}:start`, Date.now());

      logger.info('[Memory] 📅 New session started', { userId, sessionId, gapMinutes: Math.round(gap / 60000) });

      return { isNewSession: true, sessionId, gapMinutes: Math.round(gap / 60000) };
    }

    return { isNewSession: false, gapMinutes: Math.round(gap / 60000) };
  }

  if (boundary === 'end') {
    await redisCache.redis.set(`${key}:last_end`, Date.now());

    // Save session summary to DB
    if (wmState) {
      const currentGoal = wmState.currentGoal || '';
      const topics = (wmState.recentTopics || []).slice(0, 5).join(', ');
      const messageCount = wmState.messageCount || 0;

      if (messageCount >= 3) {
        try {
          await db.pool.query(
            `INSERT INTO session_summaries (user_id, session_start, message_count, main_goal, topics, wm_snapshot)
             VALUES ($1, to_timestamp($2/1000.0), $3, $4, $5, $6)`,
            [userId, Date.now() - (messageCount * 60000), messageCount, currentGoal, topics, JSON.stringify(wmState)]
          );
        } catch (err) {
          logger.warn('[Memory] Session summary save failed', { error: err.message });
        }
      }
    }

    return { saved: true };
  }
}

/**
 * Get insights from previous sessions.
 *
 * @param {string} userId
 * @param {number} [recentSessions=5]
 * @returns {Promise<{topics: Array<string>, goals: Array<string>, patterns: Array<string>}>}
 */
async function getCrossSessionInsights(userId, recentSessions = 5) {
  try {
    const result = await db.pool.query(
      `SELECT main_goal, topics, message_count, session_start
       FROM session_summaries
       WHERE user_id = $1
       ORDER BY session_start DESC
       LIMIT $2`,
      [userId, recentSessions]
    );
    const rows = result.rows;

    if (!rows || rows.length === 0) {
      return { topics: [], goals: [], patterns: [] };
    }

    const allTopics = [];
    const allGoals = [];

    for (const row of rows) {
      if (row.topics) allTopics.push(...row.topics.split(',').map(t => t.trim()).filter(Boolean));
      if (row.main_goal) allGoals.push(row.main_goal);
    }

    // Deduplicate
    const uniqueTopics = [...new Set(allTopics)].slice(0, 10);
    const uniqueGoals = [...new Set(allGoals)].slice(0, 5);

    // Detect patterns across sessions
    const patterns = [];
    const topicCounts = {};
    allTopics.forEach(t => { topicCounts[t] = (topicCounts[t] || 0) + 1; });
    for (const [topic, count] of Object.entries(topicCounts)) {
      if (count >= 2) patterns.push(`Frequently discusses: ${topic} (${count} sessions)`);
    }

    return {
      topics: uniqueTopics,
      goals: uniqueGoals,
      patterns: patterns.slice(0, 5),
    };

  } catch (err) {
    // Table may not exist yet
    logger.warn('[Memory] Cross-session insights failed', { error: err.message });
    return { topics: [], goals: [], patterns: [] };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a brief topic summary from a user message.
 */
function extractBriefTopic(text) {
  if (!text) return null;

  const lower = text.toLowerCase();
  const topicPatterns = [
    { pattern: /(?:cuaca|weather|hujan|rain)/i, topic: 'weather' },
    { pattern: /(?:remind|ingatkan|alarm)/i, topic: 'reminders' },
    { pattern: /(?:meeting|event|jadual|schedule)/i, topic: 'schedule' },
    { pattern: /(?:task|tugas|todo|goal|matlamat)/i, topic: 'tasks/goals' },
    { pattern: /(?:note|nota|simpan|save)/i, topic: 'notes' },
    { pattern: /(?:belajar|study|learn|course)/i, topic: 'learning' },
    { pattern: /(?:makan|food|restaurant|cafe)/i, topic: 'food' },
    { pattern: /(?:gym|exercise|workout|health|sihat)/i, topic: 'health' },
    { pattern: /(?:coding?|program|debug|code)/i, topic: 'coding' },
    { pattern: /(?:beli|buy|shop|price|harga)/i, topic: 'shopping' },
  ];

  for (const { pattern, topic } of topicPatterns) {
    if (pattern.test(lower)) return topic;
  }

  // Fallback: first 3 words
  const words = text.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  return words.slice(0, 3).join(' ') || null;
}

// ── DB Migration ────────────────────────────────────────────────────────────

/**
 * Create the session_summaries table if it doesn't exist.
 */
async function ensureTables() {
  try {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        session_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        message_count INTEGER DEFAULT 0,
        main_goal TEXT,
        topics TEXT,
        wm_snapshot JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_session_summaries_user ON session_summaries(user_id, session_start DESC);
    `);
    logger.info('[Memory] ✅ Hierarchy tables ready');
  } catch (err) {
    logger.warn('[Memory] Hierarchy table creation failed (non-critical)', { error: err.message });
  }
}

// ── Memory Health ───────────────────────────────────────────────────────────

/**
 * Get a health report for all memory tiers.
 */
async function getMemoryHealth(userId) {
  try {
    const stmKey = `jarvis:stm:${userId}`;
    const stmCount = await redisCache.redis.zcard(stmKey) || 0;
    const wmKey = `jarvis:wm:${userId}`;
    const wmExists = await redisCache.redis.exists(wmKey);

    const allFacts = await db.getAllFacts(userId);
    const ltmCount = allFacts.length;
    const recentLtm = allFacts.filter(f => {
      const age = f.created_at ? Date.now() - new Date(f.created_at).getTime() : Infinity;
      return age < 24 * 60 * 60 * 1000;
    }).length;

    const sessResult = await db.pool.query(
      `SELECT COUNT(*) as count FROM session_summaries WHERE user_id = $1`,
      [userId]
    );
    const sessionCount = sessResult?.rows?.[0]?.count || 0;

    return {
      stm: { count: stmCount, backend: 'redis', ttl: '24h' },
      wm: { active: wmExists === 1, backend: 'redis+process', ttl: '2h' },
      ltm: { total: ltmCount, recent: recentLtm, backend: 'postgres', ttl: 'infinite' },
      sessions: { count: sessionCount, backend: 'postgres' },
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  TIERS,
  // Short-term memory
  stmStore,
  stmRetrieve,
  stmRecordExchange,
  // Working memory bridge
  wmPersist,
  wmRestore,
  // Long-term memory
  ltmRetrieve,
  ltmCompress,
  // Unified retrieval
  unifiedRetrieve,
  // Cross-session
  trackSessionBoundary,
  getCrossSessionInsights,
  // Setup & health
  ensureTables,
  getMemoryHealth,
};
