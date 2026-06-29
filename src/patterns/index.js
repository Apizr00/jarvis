// src/patterns/index.js
// ── Pattern Recognition Engine ───────────────────────────────────────────────
// A dedicated, non-LLM system that detects patterns in user behavior,
// conversations, and data. Runs incrementally (lightweight) on each message
// and performs full analysis daily via the scheduler.
//
// Pattern types:
//   usage       - Time-of-day, day-of-week activity patterns
//   topic       - Frequently discussed keywords and themes
//   behavior    - Reminder types, task completion rates, note-taking habits
//   trend       - Changes over time (activity ↑↓, sentiment shifts)
//   correlation - Relationships between dimensions (time↔topic, etc.)

const db = require('../db');
const redisCache = require('../redis');
const { detectUsagePatterns } = require('./detectors/usage');
const { detectTopicPatterns } = require('./detectors/topics');
const { detectBehaviorPatterns } = require('./detectors/behavior');
const { detectTrends } = require('./detectors/trends');
const {
  MIN_DATA_POINTS,
  CONFIDENCE_THRESHOLD,
  mean,
  stdDev,
  zScore,
  movingAverage,
  extractKeywords,
} = require('./shared');

// ── Configuration ────────────────────────────────────────────────────────────

const PATTERN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // patterns expire after 7 days if not re-confirmed

// ── 1. Incremental Tracking (called on every message) ────────────────────────

/**
 * Track message metadata for incremental pattern building.
 * This is lightweight — just records timestamps and pre-processed keywords.
 * Called after each user message and bot response.
 *
 * @param {string} userId
 * @param {object} params
 * @param {string} params.role - 'user' or 'assistant'
 * @param {string} params.content - message text
 * @param {string} [params.toolUsed] - name of tool that was executed (if any)
 * @param {string} [params.timestamp] - ISO timestamp (defaults to now)
 */
async function trackMessage(userId, { role, content, toolUsed, timestamp }) {
  try {
    const ts = timestamp || new Date().toISOString();

    // ── Extract lightweight keywords (no LLM) ────────────────────────────
    const keywords = extractKeywords(content);

    // ── Save to pattern_tracking table ───────────────────────────────────
    await db.savePatternTracking(userId, {
      role,
      content: content.length > 500 ? content.slice(0, 500) : content,
      keywords,
      tool_used: toolUsed || null,
      created_at: ts,
    });

    // ── Periodically run fast-incremental detectors (every 10 messages) ──
    // We check if we've accumulated enough data for a quick re-analysis.
    // This is throttled via Redis to avoid running on every single message.
    const trackCount = await redisCache.incrementTrackingCounter(userId);
    if (trackCount > 0 && trackCount % 10 === 0) {
      // Fire-and-forget: run quick incremental analysis
      setImmediate(() => {
        runIncrementalAnalysis(userId).catch(err =>
          console.warn('[Patterns] Incremental analysis error:', err.message)
        );
      });
    }
  } catch (err) {
    // Non-fatal — tracking failures should never affect the bot
    console.warn('[Patterns] Track message failed:', err.message);
  }
}

// ── 2. Full Pattern Analysis (called daily by scheduler) ─────────────────────

/**
 * Run a full pattern analysis across all detectors.
 * This is the main entry point for the daily scheduled job.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.lookbackDays=30] - how many days of data to analyze
 * @returns {Promise<Array>} list of detected patterns
 */
async function runFullAnalysis(userId, options = {}) {
  const lookbackDays = options.lookbackDays || 30;
  console.log('[Patterns] 🔍 Running full pattern analysis for user ' + userId + ' (lookback: ' + lookbackDays + ' days)');

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  // ── Gather raw data ────────────────────────────────────────────────────
  const [trackingData, chatActivity, reminders, tasks, goals, notes] = await Promise.all([
    db.getPatternTracking(userId, since),
    db.getChatActivitySummary(userId, lookbackDays),
    db.getRemindersDueInRange(userId, since, new Date().toISOString()),
    db.getActiveTasks(userId),
    db.getAllGoals(userId),
    db.getRecentNotes(userId, 200),
  ]);

  // Also gather completed/cancelled tasks for rate calculation
  const allTasks = await db.getAllTasksForAnalysis(userId, since);

  const dataContext = {
    trackingData,
    chatActivity,
    reminders,
    tasks: allTasks,
    goals,
    notes,
    lookbackDays,
  };

  // ── Run all detectors in parallel ──────────────────────────────────────
  const [usagePatterns, topicPatterns, behaviorPatterns, trendPatterns] = await Promise.all([
    detectUsagePatterns(userId, dataContext),
    detectTopicPatterns(userId, dataContext),
    detectBehaviorPatterns(userId, dataContext),
    detectTrends(userId, dataContext),
  ]);

  const allPatterns = [
    ...usagePatterns,
    ...topicPatterns,
    ...behaviorPatterns,
    ...trendPatterns,
  ];

  // ── Filter by confidence ───────────────────────────────────────────────
  const significant = allPatterns.filter(p => p.confidence >= CONFIDENCE_THRESHOLD);

  // ── Save to DB ─────────────────────────────────────────────────────────
  if (significant.length > 0) {
    await db.saveDetectedPatterns(userId, significant);
    console.log('[Patterns] ✅ Saved ' + significant.length + ' patterns (of ' + allPatterns.length + ' detected)');
  } else {
    console.log('[Patterns] 📭 No significant patterns detected (need more data)');
  }

  // ── Clean up expired patterns ──────────────────────────────────────────
  await db.cleanupExpiredPatterns(userId, PATTERN_TTL_MS);

  return significant;
}

// ── 3. Incremental Analysis (lightweight, runs mid-session) ──────────────────

/**
 * Run a quick, lightweight pattern analysis that's safe to run frequently.
 * Only runs detectors that don't require heavy computation.
 *
 * @param {string} userId
 */
async function runIncrementalAnalysis(userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [trackingData, chatActivity] = await Promise.all([
    db.getPatternTracking(userId, since),
    db.getChatActivitySummary(userId, 1),
  ]);

  const dataContext = { trackingData, chatActivity, lookbackDays: 1 };

  // Only run usage patterns incrementally (topic/behavior/trends are heavier)
  const usagePatterns = await detectUsagePatterns(userId, dataContext);
  const significant = usagePatterns.filter(p => p.confidence >= CONFIDENCE_THRESHOLD);

  if (significant.length > 0) {
    await db.saveDetectedPatterns(userId, significant);
  }
}

// ── 4. Retrieve Patterns ─────────────────────────────────────────────────────

/**
 * Get all active detected patterns for a user.
 * @param {string} userId
 * @param {object} [options]
 * @param {string} [options.type] - filter by pattern type
 * @param {number} [options.minConfidence] - minimum confidence threshold
 * @param {number} [options.limit=20]
 * @returns {Promise<Array>}
 */
async function getPatterns(userId, options = {}) {
  return db.getDetectedPatterns(userId, options);
}

/**
 * Format patterns into a human-readable message.
 * @param {Array} patterns
 * @returns {string}
 */
function formatPatternsMessage(patterns) {
  if (!patterns || patterns.length === 0) {
    return '🔍 *No patterns detected yet.*\n\nKeep using me and I\'ll start noticing patterns in your behavior and conversations!';
  }

  const byType = {};
  for (const p of patterns) {
    if (!byType[p.pattern_type]) byType[p.pattern_type] = [];
    byType[p.pattern_type].push(p);
  }

  const typeLabels = {
    usage: '📊 Usage Patterns',
    topic: '💬 Conversation Topics',
    behavior: '🔄 Behavioral Patterns',
    trend: '📈 Trends',
    correlation: '🔗 Correlations',
  };

  const typeEmojis = {
    usage: '📊',
    topic: '💬',
    behavior: '🔄',
    trend: '📈',
    correlation: '🔗',
  };

  let msg = '*🔍 Pattern Analysis*\n\n';

  for (const [type, items] of Object.entries(byType)) {
    const label = typeLabels[type] || type;
    msg += '*' + label + ':*\n';

    for (const p of items.slice(0, 5)) {
      const confBar = '█'.repeat(Math.round(p.confidence * 5)) + '░'.repeat(5 - Math.round(p.confidence * 5));
      msg += '  ' + (typeEmojis[type] || '•') + ' ' + p.name + '\n';
      if (p.description) {
        msg += '    _' + p.description + '_\n';
      }
      msg += '    confidence: `' + confBar + '` ' + Math.round(p.confidence * 100) + '%\n';
    }
    msg += '\n';
  }

  msg += '_Patterns help me understand you better. They\'re detected automatically from your usage._';

  return msg;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Main API
  trackMessage,
  runFullAnalysis,
  runIncrementalAnalysis,
  getPatterns,
  formatPatternsMessage,
};

