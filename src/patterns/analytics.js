// src/patterns/analytics.js
// ── Advanced Analytics & Insights Engine ─────────────────────────────────────
//
//   1. BEHAVIORAL PREDICTION  — predict user needs based on historical patterns
//   2. PERFORMANCE METRICS     — comprehensive bot performance dashboard
//   3. A/B TESTING FRAMEWORK   — test different behaviors/responses
//   4. USER JOURNEY MAPPING    — track & analyze interaction flows
//
// All data is stored in DB via pattern_tracking + new analytics tables.

const db = require('../db');
const { logger } = require('../utils/logger');
const { dayjs, fmt } = require('../utils/datetime');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. BEHAVIORAL PREDICTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Time-slot activity profile for a user.
 */
const DAY_SLOTS = [
  { name: 'early_morning', start: 0, end: 6, label: '🌙 Early Morning (12am-6am)' },
  { name: 'morning', start: 6, end: 9, label: '🌅 Morning (6am-9am)' },
  { name: 'late_morning', start: 9, end: 12, label: '☀️ Late Morning (9am-12pm)' },
  { name: 'afternoon', start: 12, end: 15, label: '🌤️ Afternoon (12pm-3pm)' },
  { name: 'late_afternoon', start: 15, end: 18, label: '🌥️ Late Afternoon (3pm-6pm)' },
  { name: 'evening', start: 18, end: 21, label: '🌆 Evening (6pm-9pm)' },
  { name: 'night', start: 21, end: 24, label: '🌃 Night (9pm-12am)' },
];

/**
 * Predict user behavior based on historical patterns.
 *
 * @param {string} userId
 * @returns {Promise<{
 *   predictedNextAction: {type: string, confidence: number, reason: string},
 *   predictedTimeSlot: {slot: string, confidence: number},
 *   predictedTopics: Array<{topic: string, confidence: number}>,
 *   moodPrediction: {mood: string, confidence: number, evidence: string},
 *   activityForecast: {busyDay: boolean, expectedMessages: number}
 * }>}
 */
async function predictBehavior(userId) {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay(); // 0=Sun, 6=Sat

  // ── Fetch historical data ─────────────────────────────────────────────
  let trackingData = [];
  let patterns = [];
  try {
    const since = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    trackingData = await db.getPatternTracking(userId, since, 500);
    patterns = await db.getDetectedPatterns(userId, { limit: 30, minConfidence: 0.3 });
  } catch {
    // Graceful degradation — return low-confidence predictions
    return buildEmptyPrediction();
  }

  if (trackingData.length < 5) return buildEmptyPrediction();

  // ── 1. Predict next action type ──────────────────────────────────────
  const actionPrediction = predictNextAction(trackingData, patterns);

  // ── 2. Predict time slot ─────────────────────────────────────────────
  const timePrediction = predictTimeSlot(trackingData, currentDay);

  // ── 3. Predict topics ────────────────────────────────────────────────
  const topicPrediction = predictTopics(trackingData, patterns, currentHour);

  // ── 4. Mood prediction ───────────────────────────────────────────────
  const moodPrediction = predictMood(trackingData, patterns, currentDay, currentHour);

  // ── 5. Activity forecast ─────────────────────────────────────────────
  const activityForecast = forecastActivity(trackingData, currentDay);

  return {
    predictedNextAction: actionPrediction,
    predictedTimeSlot: timePrediction,
    predictedTopics: topicPrediction,
    moodPrediction,
    activityForecast,
    generatedAt: new Date().toISOString(),
  };
}

function buildEmptyPrediction() {
  return {
    predictedNextAction: { type: 'unknown', confidence: 0, reason: 'Not enough data' },
    predictedTimeSlot: { slot: 'unknown', confidence: 0 },
    predictedTopics: [],
    moodPrediction: { mood: 'unknown', confidence: 0, evidence: 'Not enough data' },
    activityForecast: { busyDay: false, expectedMessages: 0 },
    generatedAt: new Date().toISOString(),
  };
}

function predictNextAction(trackingData, patterns) {
  // Analyze recent 50 messages for action patterns
  const recent = trackingData.slice(0, 50);
  const toolUsage = {};

  for (const entry of recent) {
    if (entry.tool_used) {
      toolUsage[entry.tool_used] = (toolUsage[entry.tool_used] || 0) + 1;
    }
  }

  // Most used tool
  const sorted = Object.entries(toolUsage).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    return { type: 'chat', confidence: 0.3, reason: 'User mostly chats without tools' };
  }

  const [topTool, count] = sorted[0];
  const totalMessages = recent.length;
  const confidence = Math.min(count / Math.max(totalMessages * 0.1, 1), 0.9);

  // Check for time-based patterns
  const patternNames = patterns.map(p => p.name);
  const hasMorningRoutine = patternNames.some(n => n.includes('morning') || n.includes('routine'));
  const hasWorkPattern = patternNames.some(n => n.includes('work') || n.includes('productivity'));

  let reason = `Used "${topTool}" ${count} times in recent messages`;
  if (hasMorningRoutine && currentHour() < 9) {
    reason += ' (morning routine active)';
  }

  return { type: topTool, confidence, reason };
}

function predictTimeSlot(trackingData, currentDay) {
  // Group messages by hour
  const hourCounts = new Array(24).fill(0);
  for (const entry of trackingData) {
    const hour = new Date(entry.created_at).getHours();
    hourCounts[hour]++;
  }

  // Find peak hour
  let peakHour = 0;
  let peakCount = 0;
  for (let h = 0; h < 24; h++) {
    if (hourCounts[h] > peakCount) {
      peakCount = hourCounts[h];
      peakHour = h;
    }
  }

  // Find which slot
  for (const slot of DAY_SLOTS) {
    if (peakHour >= slot.start && peakHour < slot.end) {
      const total = hourCounts.reduce((a, b) => a + b, 0);
      return {
        slot: slot.name,
        label: slot.label,
        hour: peakHour,
        confidence: total > 0 ? Math.min(peakCount / (total / trackingData.length), 0.95) : 0.3,
      };
    }
  }

  return { slot: 'unknown', label: 'Unknown', hour: peakHour, confidence: 0.2 };
}

function predictTopics(trackingData, patterns, currentHour) {
  const topicCounts = {};

  // Extract keywords from recent messages
  for (const entry of trackingData.slice(0, 100)) {
    const keywords = entry.keywords || [];
    for (const kw of keywords) {
      topicCounts[kw] = (topicCounts[kw] || 0) + 1;
    }
  }

  // Add pattern-based topics
  const topicPatterns = patterns.filter(p => p.pattern_type === 'topic');
  for (const p of topicPatterns) {
    const name = p.name.replace(/^topic:/, '');
    topicCounts[name] = (topicCounts[name] || 0) + Math.round(p.confidence * 10);
  }

  // Sort and return top 5
  return Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => ({
      topic,
      confidence: Math.min(count / 10, 0.9),
    }));
}

function predictMood(trackingData, patterns, currentDay, currentHour) {
  // Simple mood detection: check for positive/negative keywords
  let positiveCount = 0;
  let negativeCount = 0;

  const positiveWords = ['thanks', 'good', 'great', 'nice', 'awesome', 'love', 'happy', 'best', '👍', '✅'];
  const negativeWords = ['bad', 'sad', 'worried', 'stress', 'tired', 'hate', 'frustrated', 'angry', '😔', '❌'];

  for (const entry of trackingData.slice(0, 50)) {
    const text = (entry.content || '').toLowerCase();
    for (const w of positiveWords) {
      if (text.includes(w)) positiveCount++;
    }
    for (const w of negativeWords) {
      if (text.includes(w)) negativeCount++;
    }
  }

  const total = positiveCount + negativeCount;
  if (total === 0) return { mood: 'neutral', confidence: 0.5, evidence: 'No strong signals' };

  const ratio = positiveCount / Math.max(total, 1);

  if (ratio > 0.7) return { mood: 'positive', confidence: ratio, evidence: `${positiveCount} positive vs ${negativeCount} negative signals` };
  if (ratio < 0.3) return { mood: 'negative', confidence: 1 - ratio, evidence: `${negativeCount} negative vs ${positiveCount} positive signals` };
  return { mood: 'neutral', confidence: 0.5, evidence: 'Balanced signals' };
}

function forecastActivity(trackingData, currentDay) {
  // Calculate average messages per day
  const dayCounts = {};
  for (const entry of trackingData) {
    const day = new Date(entry.created_at).toDateString();
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  }

  const days = Object.keys(dayCounts);
  if (days.length < 2) return { busyDay: false, expectedMessages: 0 };

  const avgPerDay = Object.values(dayCounts).reduce((a, b) => a + b, 0) / days.length;

  // Check if today is typically busy
  const sameDayEntries = trackingData.filter(e => new Date(e.created_at).getDay() === currentDay);
  const sameDayAvg = sameDayEntries.length / Math.max(days.length / 7, 1);

  return {
    busyDay: sameDayAvg > avgPerDay * 1.3,
    expectedMessages: Math.round(avgPerDay),
    sameDayAverage: Math.round(sameDayAvg),
    overallAverage: Math.round(avgPerDay),
  };
}

/**
 * Format prediction as a readable message for Telegram.
 */
function formatBehaviorPrediction(userId, prediction) {
  const p = prediction || buildEmptyPrediction();

  let msg = '🔮 *Behavioral Prediction*\n\n';

  msg += '*Next Action:* ' + p.predictedNextAction.type;
  msg += ' _(conf: ' + Math.round(p.predictedNextAction.confidence * 100) + '%)_\n';
  msg += '  ' + p.predictedNextAction.reason + '\n\n';

  msg += '*Peak Time:* ' + (p.predictedTimeSlot.label || 'unknown');
  msg += ' _(conf: ' + Math.round(p.predictedTimeSlot.confidence * 100) + '%)_\n\n';

  if (p.predictedTopics.length > 0) {
    msg += '*Likely Topics:*\n';
    for (const t of p.predictedTopics.slice(0, 3)) {
      msg += '  • ' + t.topic + ' (' + Math.round(t.confidence * 100) + '%)\n';
    }
    msg += '\n';
  }

  msg += '*Mood:* ' + p.moodPrediction.mood;
  msg += ' _(conf: ' + Math.round(p.moodPrediction.confidence * 100) + '%)_\n';
  msg += '  ' + p.moodPrediction.evidence + '\n\n';

  msg += '*Activity:* ' + (p.activityForecast.busyDay ? '🔴 Busy day expected' : '🟢 Normal day');
  msg += ' (~' + p.activityForecast.expectedMessages + ' msgs)\n';

  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PERFORMANCE METRICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Comprehensive bot performance metrics.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.days=30] — lookback period
 * @returns {Promise<object>} full performance dashboard
 */
async function getPerformanceMetrics(userId, options = {}) {
  const days = options.days || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Fetch data
  let trackingData = [];
  let patterns = [];
  let chatActivity = [];
  try {
    trackingData = await db.getPatternTracking(userId, since, 1000);
    patterns = await db.getDetectedPatterns(userId, { limit: 50 });
    chatActivity = await db.getChatActivitySummary(userId, days);
  } catch {
    return { error: 'Could not fetch performance data' };
  }

  // ── Latency metrics (from state machine traces) ──────────────────────
  const latency = calculateLatencyMetrics(userId);

  // ── Accuracy metrics ─────────────────────────────────────────────────
  const accuracy = calculateAccuracyMetrics(trackingData);

  // ── Engagement metrics ───────────────────────────────────────────────
  const engagement = calculateEngagementMetrics(chatActivity, trackingData);

  // ── Tool execution metrics ───────────────────────────────────────────
  const tools = calculateToolMetrics(trackingData);

  // ── Pattern health ───────────────────────────────────────────────────
  const patternHealth = calculatePatternHealth(patterns);

  // ── Overall score ────────────────────────────────────────────────────
  const overallScore = Math.round(
    (accuracy.successRate * 0.3 +
      engagement.responseRate * 0.25 +
      tools.successRate * 0.2 +
      patternHealth.activeRatio * 0.15 +
      latency.healthScore * 0.1) * 100
  );

  return {
    period: `${days} days`,
    generatedAt: new Date().toISOString(),
    overallScore,
    grade: scoreToGrade(overallScore),
    latency,
    accuracy,
    engagement,
    tools,
    patternHealth,
  };
}

function calculateLatencyMetrics(userId) {
  try {
    const stateMachine = require('../executive/state-machine');
    const traces = stateMachine.getRecentTraces(userId, 50);

    if (traces.length === 0) {
      return { avgMs: 0, p95Ms: 0, p99Ms: 0, healthScore: 0.5, samples: 0 };
    }

    const durations = traces.map(t => t.durationMs || 0).filter(d => d > 0);
    if (durations.length === 0) return { avgMs: 0, p95Ms: 0, p99Ms: 0, healthScore: 0.5, samples: 0 };

    durations.sort((a, b) => a - b);
    const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    const p95 = durations[Math.floor(durations.length * 0.95)] || durations[durations.length - 1];
    const p99 = durations[Math.floor(durations.length * 0.99)] || durations[durations.length - 1];

    // Health: <2s avg = healthy, >5s = unhealthy
    const healthScore = avg < 2000 ? 1.0 : avg < 5000 ? 0.6 : 0.2;

    return { avgMs: avg, p95Ms: p95, p99Ms: p99, healthScore, samples: durations.length };
  } catch {
    return { avgMs: 0, p95Ms: 0, p99Ms: 0, healthScore: 0, samples: 0 };
  }
}

function calculateAccuracyMetrics(trackingData) {
  // Check how often user needed to repeat/correct the bot
  const userMessages = trackingData.filter(e => e.role === 'user');
  const corrections = userMessages.filter(e => {
    const text = (e.content || '').toLowerCase();
    return /(?:no|wrong|bukan|salah|not\s+that|correct|betulkan|bukan\s+itu)/i.test(text);
  });

  const totalInteractions = userMessages.length;
  const correctionRate = totalInteractions > 0 ? corrections.length / totalInteractions : 0;
  const successRate = Math.max(0, 1 - correctionRate);

  return {
    totalInteractions,
    corrections: corrections.length,
    correctionRate: Math.round(correctionRate * 100) / 100,
    successRate: Math.round(successRate * 100) / 100,
    grade: successRate > 0.95 ? 'A' : successRate > 0.85 ? 'B' : successRate > 0.7 ? 'C' : 'D',
  };
}

function calculateEngagementMetrics(chatActivity, trackingData) {
  const totalUserMsgs = chatActivity.reduce((s, d) => s + parseInt(d.user_count || 0), 0);
  const totalAssistantMsgs = chatActivity.reduce((s, d) => s + parseInt(d.assistant_count || 0), 0);
  const activeDays = chatActivity.filter(d => parseInt(d.user_count || 0) > 0).length;
  const totalDays = chatActivity.length || 1;

  const responseRate = totalUserMsgs > 0
    ? Math.min(totalAssistantMsgs / totalUserMsgs, 1)
    : 0;

  // Session metrics
  const sessions = detectSessions(trackingData);

  return {
    totalUserMessages: totalUserMsgs,
    totalBotMessages: totalAssistantMsgs,
    responseRate: Math.round(responseRate * 100) / 100,
    activeDays,
    totalDays,
    dailyActivity: Math.round((totalUserMsgs / Math.max(activeDays, 1)) * 10) / 10,
    sessions: sessions.length,
    avgSessionLength: sessions.length > 0
      ? Math.round(sessions.reduce((s, sess) => s + sess.messageCount, 0) / sessions.length)
      : 0,
  };
}

function detectSessions(trackingData) {
  const sessions = [];
  let currentSession = null;
  const GAP_MS = 30 * 60 * 1000; // 30 min gap = new session

  for (const entry of trackingData) {
    const ts = new Date(entry.created_at).getTime();
    if (!currentSession || ts - currentSession.lastTs > GAP_MS) {
      if (currentSession) sessions.push(currentSession);
      currentSession = { startTs: ts, lastTs: ts, messageCount: 1 };
    } else {
      currentSession.lastTs = ts;
      currentSession.messageCount++;
    }
  }
  if (currentSession) sessions.push(currentSession);

  return sessions;
}

function calculateToolMetrics(trackingData) {
  const toolEntries = trackingData.filter(e => e.tool_used);
  const toolCounts = {};

  for (const entry of toolEntries) {
    const tool = entry.tool_used;
    if (!toolCounts[tool]) toolCounts[tool] = { total: 0, success: 0 };
    toolCounts[tool].total++;
    // Consider successful unless explicitly failed
    if (!entry.content?.includes('error') && !entry.content?.includes('failed')) {
      toolCounts[tool].success++;
    }
  }

  const totalToolCalls = toolEntries.length;
  const totalSuccess = Object.values(toolCounts).reduce((s, t) => s + t.success, 0);

  return {
    totalToolCalls,
    successRate: totalToolCalls > 0 ? Math.round((totalSuccess / totalToolCalls) * 100) / 100 : 0,
    byTool: Object.entries(toolCounts)
      .map(([name, stats]) => ({
        name,
        total: stats.total,
        successRate: Math.round((stats.success / stats.total) * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total),
  };
}

function calculatePatternHealth(patterns) {
  const active = patterns.filter(p => p.active !== false);
  const highConf = active.filter(p => p.confidence >= 0.7);

  return {
    totalDetected: patterns.length,
    active: active.length,
    highConfidence: highConf.length,
    activeRatio: patterns.length > 0 ? active.length / patterns.length : 0,
    domainCoverage: [...new Set(patterns.map(p => p.pattern_type))].length,
  };
}

function scoreToGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

/**
 * Format performance metrics as a Telegram message.
 */
function formatPerformanceReport(userId, metrics) {
  const m = metrics;
  if (m.error) return '❌ ' + m.error;

  let msg = '📊 *Performance Report* _(last ' + m.period + ')_\n\n';

  msg += '*Overall:* ' + m.overallScore + '/100 — Grade: *' + m.grade + '*\n\n';

  msg += '⏱️ *Latency:*\n';
  msg += '  Avg: ' + m.latency.avgMs + 'ms | P95: ' + m.latency.p95Ms + 'ms\n';
  msg += '  Health: ' + '█'.repeat(Math.round(m.latency.healthScore * 10)) + '\n\n';

  msg += '🎯 *Accuracy:*\n';
  msg += '  Success rate: ' + Math.round(m.accuracy.successRate * 100) + '% (' + m.accuracy.grade + ')\n';
  msg += '  Corrections needed: ' + m.accuracy.corrections + '/' + m.accuracy.totalInteractions + '\n\n';

  msg += '💬 *Engagement:*\n';
  msg += '  Messages: ' + m.engagement.totalUserMessages + ' user / ' + m.engagement.totalBotMessages + ' bot\n';
  msg += '  Active: ' + m.engagement.activeDays + '/' + m.engagement.totalDays + ' days\n';
  msg += '  Sessions: ' + m.engagement.sessions + ' (avg ' + m.engagement.avgSessionLength + ' msgs)\n\n';

  msg += '🔧 *Tools:*\n';
  msg += '  Success: ' + Math.round(m.tools.successRate * 100) + '% (' + m.tools.totalToolCalls + ' calls)\n';
  for (const t of m.tools.byTool.slice(0, 3)) {
    msg += '  • ' + t.name + ': ' + Math.round(t.successRate * 100) + '%\n';
  }

  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. A/B TESTING FRAMEWORK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Active A/B tests store (in-memory + DB).
 */
const abTests = new Map(); // testId → test config

/**
 * Create an A/B test to compare two bot behaviors.
 *
 * @param {object} config
 * @param {string} config.name — test name
 * @param {string} config.variantA — description of variant A
 * @param {string} config.variantB — description of variant B
 * @param {Function} config.selector — (userId, context) → 'A'|'B'
 * @param {number} [config.durationHours=168] — how long to run (default: 1 week)
 * @returns {{testId: string, name: string}}
 */
function createABTest(config) {
  const testId = 'ab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);

  const test = {
    testId,
    name: config.name,
    variantA: config.variantA,
    variantB: config.variantB,
    selector: config.selector || (() => Math.random() < 0.5 ? 'A' : 'B'),
    startTime: Date.now(),
    endTime: Date.now() + (config.durationHours || 168) * 60 * 60 * 1000,
    results: {
      A: { impressions: 0, successes: 0, avgQuality: 0, qualityScores: [] },
      B: { impressions: 0, successes: 0, avgQuality: 0, qualityScores: [] },
    },
    active: true,
  };

  abTests.set(testId, test);
  logger.info('[ABTest] 🧪 Created:', { testId, name: config.name });

  return { testId, name: config.name };
}

/**
 * Get the variant for a user in an active A/B test.
 *
 * @param {string} testId
 * @param {string} userId
 * @param {object} [context] — additional context for selector
 * @returns {'A'|'B'|null} null if test not found or expired
 */
function getABVariant(testId, userId, context = {}) {
  const test = abTests.get(testId);
  if (!test || !test.active) return null;
  if (Date.now() > test.endTime) {
    test.active = false;
    return null;
  }

  return test.selector(userId, context);
}

/**
 * Record an impression/result for an A/B test variant.
 *
 * @param {string} testId
 * @param {'A'|'B'} variant
 * @param {object} outcome
 * @param {boolean} [outcome.success] — was the interaction successful?
 * @param {number} [outcome.qualityScore] — quality score (0-100)
 */
function recordABResult(testId, variant, outcome = {}) {
  const test = abTests.get(testId);
  if (!test) return;

  const results = test.results[variant];
  results.impressions++;

  if (outcome.success !== undefined && outcome.success) {
    results.successes++;
  }

  if (outcome.qualityScore !== undefined) {
    results.qualityScores.push(outcome.qualityScore);
    results.avgQuality = Math.round(
      results.qualityScores.reduce((a, b) => a + b, 0) / results.qualityScores.length
    );
  }
}

/**
 * Get the results of an A/B test.
 */
function getABResults(testId) {
  const test = abTests.get(testId);
  if (!test) return { error: 'Test not found' };

  const { A, B } = test.results;
  const total = A.impressions + B.impressions;

  const aSuccessRate = A.impressions > 0 ? A.successes / A.impressions : 0;
  const bSuccessRate = B.impressions > 0 ? B.successes / B.impressions : 0;
  const winner = aSuccessRate > bSuccessRate ? 'A' : bSuccessRate > aSuccessRate ? 'B' : 'tie';
  const significance = total > 10
    ? Math.abs(aSuccessRate - bSuccessRate) > 0.1
      ? 'significant'
      : 'not significant'
    : 'needs more data';

  return {
    testId,
    name: test.name,
    status: test.active ? 'running' : 'completed',
    elapsed: Math.round((Date.now() - test.startTime) / 3600000) + 'h',
    variantA: { label: test.variantA, ...A, successRate: Math.round(aSuccessRate * 100) / 100 },
    variantB: { label: test.variantB, ...B, successRate: Math.round(bSuccessRate * 100) / 100 },
    total,
    winner,
    significance,
    recommendation: winner === 'tie'
      ? 'No clear winner — continue testing or pick either.'
      : `Variant ${winner} is winning (${significance}).`,
  };
}

/**
 * Stop an A/B test.
 */
function stopABTest(testId) {
  const test = abTests.get(testId);
  if (!test) return { error: 'Test not found' };
  test.active = false;
  test.endTime = Date.now();
  return getABResults(testId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. USER JOURNEY MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Journey step types.
 */
const JOURNEY_STEPS = {
  GREETING: 'greeting',
  QUESTION: 'question',
  TOOL_REQUEST: 'tool_request',
  TOOL_EXECUTION: 'tool_execution',
  CLARIFICATION: 'clarification',
  FOLLOW_UP: 'follow_up',
  FEEDBACK: 'feedback',
  FAREWELL: 'farewell',
};

/**
 * Map a user's journey through interactions with the bot.
 *
 * @param {string} userId
 * @param {number} [sessions=5] — number of recent sessions to analyze
 * @returns {Promise<object>} journey map
 */
async function mapUserJourney(userId, sessions = 5) {
  let trackingData = [];
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    trackingData = await db.getPatternTracking(userId, since, 1000);
  } catch {
    return { error: 'Could not fetch journey data' };
  }

  if (trackingData.length === 0) {
    return { sessions: [], commonPaths: [], insights: 'No journey data yet.' };
  }

  // ── Split into sessions ──────────────────────────────────────────────
  const sessionList = detectSessions(trackingData).slice(-sessions);

  // ── Classify each message into journey steps ─────────────────────────
  const journeySessions = sessionList.map(sess => {
    const sessEntries = trackingData.filter(e => {
      const ts = new Date(e.created_at).getTime();
      return ts >= sess.startTs && ts <= sess.lastTs;
    });

    const steps = sessEntries.map(e => classifyJourneyStep(e));
    const flow = extractFlow(steps);

    return {
      startTime: new Date(sess.startTs).toISOString(),
      messageCount: sess.messageCount,
      steps,
      flow,
      dominantStep: getDominantStep(steps),
      toolUsage: sessEntries.filter(e => e.tool_used).map(e => e.tool_used),
    };
  });

  // ── Find common paths across sessions ────────────────────────────────
  const commonPaths = findCommonPaths(journeySessions);

  // ── Generate journey insights ────────────────────────────────────────
  const insights = generateJourneyInsights(journeySessions, commonPaths);

  return {
    sessions: journeySessions,
    commonPaths,
    insights,
    totalSessions: sessionList.length,
    analyzedSessions: journeySessions.length,
  };
}

function classifyJourneyStep(entry) {
  const text = (entry.content || '').toLowerCase();

  if (entry.tool_used) {
    return { type: JOURNEY_STEPS.TOOL_EXECUTION, tool: entry.tool_used, text: text.slice(0, 80) };
  }

  if (entry.role === 'user') {
    if (/^(hi|hello|hey|hai|selamat|assalam|salam|yo)\b/i.test(text)) {
      return { type: JOURNEY_STEPS.GREETING, text: text.slice(0, 80) };
    }
    if (/\?$/i.test(text) || /\b(what|how|when|where|who|why|apa|bila|mana|siapa|bagaimana|kenapa|mengapa)\b/i.test(text)) {
      return { type: JOURNEY_STEPS.QUESTION, text: text.slice(0, 80) };
    }
    if (/\b(set|create|add|tambah|buat|remind|ingatkan|simpan|save|delete|padam|cancel)\b/i.test(text)) {
      return { type: JOURNEY_STEPS.TOOL_REQUEST, text: text.slice(0, 80) };
    }
    if (/\b(thanks|thank|terima\s*kasih|good|great|nice|awesome|bagus)\b/i.test(text)) {
      return { type: JOURNEY_STEPS.FEEDBACK, text: text.slice(0, 80) };
    }
    if (/\b(bye|goodbye|bai|jumpa|night)\b/i.test(text)) {
      return { type: JOURNEY_STEPS.FAREWELL, text: text.slice(0, 80) };
    }
    return { type: JOURNEY_STEPS.QUESTION, text: text.slice(0, 80) };
  }

  // Assistant messages
  if (/\?$/i.test(text) || /\b(what|which|when|how|would|boleh|nak|mahu)\b.*\?/i.test(text)) {
    return { type: JOURNEY_STEPS.CLARIFICATION, text: text.slice(0, 80) };
  }
  if (/\b(also|additionally|by\s+the\s+way|btw|ps|p\.s\.|while|juga|selain|lagi\s+satu|nak\s+tanya)\b/i.test(text)) {
    return { type: JOURNEY_STEPS.FOLLOW_UP, text: text.slice(0, 80) };
  }
  return { type: JOURNEY_STEPS.TOOL_EXECUTION, tool: 'message', text: text.slice(0, 80) };
}

function extractFlow(steps) {
  const types = steps.map(s => s.type);
  const transitions = [];
  for (let i = 0; i < types.length - 1; i++) {
    transitions.push(types[i] + '→' + types[i + 1]);
  }
  return transitions;
}

function getDominantStep(steps) {
  const counts = {};
  for (const s of steps) {
    counts[s.type] = (counts[s.type] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || 'unknown';
}

function findCommonPaths(journeySessions) {
  const allFlows = journeySessions.flatMap(s => s.flow);
  const flowCounts = {};

  for (const f of allFlows) {
    flowCounts[f] = (flowCounts[f] || 0) + 1;
  }

  return Object.entries(flowCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([flow, count]) => ({ flow, count, frequency: Math.round(count / journeySessions.length * 100) / 100 }));
}

function generateJourneyInsights(sessions, commonPaths) {
  const insights = [];

  // Most common flow
  if (commonPaths.length > 0) {
    insights.push(`Most common flow: ${commonPaths[0].flow} (${commonPaths[0].count}x)`);
  }

  // Session length trend
  const lengths = sessions.map(s => s.messageCount);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / Math.max(lengths.length, 1);
  const trend = lengths.length >= 2
    ? lengths[lengths.length - 1] > lengths[0] ? 'increasing 📈' : 'decreasing 📉'
    : 'stable';

  insights.push(`Session length: avg ${Math.round(avgLength)} msgs, trend: ${trend}`);

  // Tool usage pattern
  const allTools = sessions.flatMap(s => s.toolUsage);
  const toolCounts = {};
  allTools.forEach(t => { toolCounts[t] = (toolCounts[t] || 0) + 1; });
  const topTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0];
  if (topTool) {
    insights.push(`Top tool: ${topTool[0]} (${topTool[1]}x)`);
  }

  // Clarification rate
  const allSteps = sessions.flatMap(s => s.steps);
  const clarificationCount = allSteps.filter(s => s.type === JOURNEY_STEPS.CLARIFICATION).length;
  const clarificationRate = allSteps.length > 0 ? clarificationCount / allSteps.length : 0;

  if (clarificationRate > 0.2) {
    insights.push(`High clarification rate: ${Math.round(clarificationRate * 100)}% — bot may need clearer responses`);
  } else if (clarificationRate < 0.05) {
    insights.push('Low clarification rate: responses are well-understood ✅');
  }

  return insights;
}

/**
 * Format journey map as a Telegram message.
 */
function formatJourneyReport(userId, journey) {
  const j = journey;
  if (j.error) return '❌ ' + j.error;

  let msg = '🗺️ *User Journey Map* _(last ' + j.analyzedSessions + ' sessions)_\n\n';

  if (j.insights.length > 0) {
    msg += '*Insights:*\n';
    for (const insight of j.insights) {
      msg += '  • ' + insight + '\n';
    }
    msg += '\n';
  }

  if (j.commonPaths.length > 0) {
    msg += '*Common Flows:*\n';
    for (const path of j.commonPaths.slice(0, 5)) {
      msg += '  `' + path.flow + '` (' + path.count + 'x)\n';
    }
    msg += '\n';
  }

  msg += '*Recent Sessions:*\n';
  for (const sess of j.sessions.slice(-3)) {
    const time = fmt(sess.startTime, 'MMM D, h:mm A');
    msg += '  ' + time + ' — ' + sess.messageCount + ' msgs, mainly ' + sess.dominantStep + '\n';
  }

  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DB MIGRATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function ensureTables() {
  try {
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS ab_tests (
        id SERIAL PRIMARY KEY,
        test_id TEXT UNIQUE NOT NULL,
        user_id TEXT,
        name TEXT NOT NULL,
        variant_a TEXT,
        variant_b TEXT,
        results JSONB DEFAULT '{}',
        start_time TIMESTAMPTZ DEFAULT NOW(),
        end_time TIMESTAMPTZ,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS performance_snapshots (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        metrics JSONB NOT NULL,
        snapshot_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_perf_snapshots_user ON performance_snapshots(user_id, snapshot_date DESC);
    `);
    logger.info('[Analytics] ✅ Tables ready');
  } catch (err) {
    logger.warn('[Analytics] Table creation failed (non-critical)', { error: err.message });
  }
}

/**
 * Save a performance snapshot to DB for historical tracking.
 */
async function savePerformanceSnapshot(userId, metrics) {
  try {
    await db.pool.query(
      `INSERT INTO performance_snapshots (user_id, metrics) VALUES ($1, $2)`,
      [userId, JSON.stringify(metrics)]
    );
  } catch {
    // Non-critical
  }
}

/**
 * Get historical performance snapshots.
 */
async function getPerformanceHistory(userId, limit = 30) {
  try {
    const result = await db.pool.query(
      `SELECT metrics, snapshot_date FROM performance_snapshots
       WHERE user_id = $1
       ORDER BY snapshot_date DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(r => ({
      ...(typeof r.metrics === 'string' ? JSON.parse(r.metrics) : r.metrics),
      date: r.snapshot_date,
    }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Behavioral Prediction
  predictBehavior,
  formatBehaviorPrediction,

  // Performance Metrics
  getPerformanceMetrics,
  formatPerformanceReport,
  savePerformanceSnapshot,
  getPerformanceHistory,
  scoreToGrade,

  // A/B Testing
  createABTest,
  getABVariant,
  recordABResult,
  getABResults,
  stopABTest,

  // User Journey Mapping
  mapUserJourney,
  formatJourneyReport,
  JOURNEY_STEPS,

  // Setup
  ensureTables,
};
