// src/executive/evaluator.js
// ── Self Evaluation + Faster Reflection (Fasa 5) ────────────────────────────
// Evaluates response quality, triggers fast reflections, and generates
// proactive suggestions so the bot can initiate conversations.
//
// Components:
//   1. Response quality evaluator — scores bot's own responses
//   2. Fast reflection — quick self-check after deep interactions
//   3. Proactive suggestion engine — decides when bot should initiate chat
//   4. Learning tracker — tracks what works/doesn't for future improvement

const db = require('../db');
const workingMemory = require('./working-memory');

// ── 1. Response Quality Evaluator ──────────────────────────────────────────

/**
 * Quick heuristic evaluation of bot response quality.
 * Runs inline (no LLM call) to avoid adding latency.
 * 
 * @param {object} params
 * @param {string} params.userMessage - original user message
 * @param {string} params.botResponse - bot's final response
 * @param {string} params.tier - fast/medium/deep
 * @param {string} params.category - intent category
 * @returns {{score: number, issues: string[], suggestions: string[]}}
 */
function evaluateResponseQuality({ userMessage, botResponse, tier, category }) {
  const issues = [];
  const suggestions = [];
  let score = 100;

  // ── Heuristic 1: Length check ─────────────────────────────────────────
  // Too short for complex queries = bad
  if (tier === 'deep' && botResponse.length < 50) {
    issues.push('Response too short for deep query');
    score -= 20;
    suggestions.push('Provide more detailed explanation for complex queries');
  }

  // Too long for fast queries = overkill
  if (tier === 'fast' && botResponse.length > 500) {
    issues.push('Response too long for simple query');
    score -= 10;
  }

  // ── Heuristic 2: Did the bot repeat the user's question verbatim? ─────
  // (Common LLM failure mode)
  const userWords = userMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const repeatedWords = userWords.filter(w =>
    botResponse.toLowerCase().includes(w)
  ).length;
  const repetitionRatio = repeatedWords / userWords.length;

  if (repetitionRatio > 0.8 && userWords.length > 5) {
    issues.push('Response echoes user message too closely');
    score -= 15;
    suggestions.push('Provide original content, not just rephrasing');
  }

  // ── Heuristic 3: Question answered? ───────────────────────────────────
  // If user asked a question, does the response seem to answer it?
  const isQuestion = userMessage.includes('?') ||
    /what|who|when|where|why|how|apa|siapa|bila|mana|kenapa|bagaimana|macam\s*mana/i.test(userMessage);

  if (isQuestion && botResponse.length < 20) {
    issues.push('Question received but response too short');
    score -= 20;
  }

  // ── Heuristic 4: Hallucination markers ────────────────────────────────
  const hallucinationMarkers = [
    /\b(i've\s+(created|set|saved|added|updated|cancelled|deleted))/i,
    /\b(i\s+have\s+(created|set|saved|added))/i,
    /\b(dah\s+(set|create|tambah|save|cancel))/,
    /\b(siap\s+dah|okay\s+dah)\b/,
  ];

  for (const marker of hallucinationMarkers) {
    if (marker.test(botResponse)) {
      issues.push('Response contains hallucination markers');
      score -= 30;
      suggestions.push('Use tool calls for actions, not natural language claims');
      break;
    }
  }

  // ── Heuristic 5: Actionable response? ─────────────────────────────────
  // Does the response help the user move forward?
  const actionWords = /\b(try|consider|check|review|update|create|set|add|remove|delete|plan|schedule|jadual|cuba|check|semak|buat|tambah)\b/i;
  if (tier !== 'fast' && !actionWords.test(botResponse)) {
    issues.push('Response lacks actionable suggestions');
    score -= 10;
  }

  // ── Heuristic 6: Polite and warm? ─────────────────────────────────────
  const politenessWords = /\b(please|sila|thank|terima|appreciate|happy|gembira|great|bagus|awesome)\b/i;
  if (!politenessWords.test(botResponse) && botResponse.length > 100) {
    // Not a big issue, just a note
    suggestions.push('Consider adding a warm/polite tone');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    issues,
    suggestions,
    quality: score >= 80 ? 'good' : score >= 50 ? 'acceptable' : 'poor',
  };
}

// ── 2. Fast Reflection ─────────────────────────────────────────────────────

/**
 * Perform a quick self-reflection after deep interactions.
 * This is lightweight and doesn't call the LLM — it's pattern-based.
 * 
 * @param {string} userId
 * @param {object} decision - from executive.decide()
 * @param {object} llmResponse - the LLM response
 * @returns {{shouldReflect: boolean, reflectionNotes: string[]}}
 */
function fastReflection(userId, decision, llmResponse) {
  const notes = [];
  let shouldReflect = false;

  // ── Trigger conditions ────────────────────────────────────────────────

  // 1. Multiple deep messages in a row → reflect
  const wm = workingMemory.get(userId);
  if (wm.messageCount >= 10 && decision.tier === 'deep') {
    shouldReflect = true;
    notes.push('10+ messages in deep mode — consider summarizing progress');
  }

  // 2. User mood is negative → reflect
  if (decision.mood && ['sad', 'angry', 'anxious', 'tired'].includes(decision.mood)) {
    shouldReflect = true;
    notes.push('User mood is ' + decision.mood + ' — adjust tone and approach');
  }

  // 3. Response quality check
  if (llmResponse && llmResponse.content) {
    const quality = evaluateResponseQuality({
      userMessage: decision.intent?.reason || '',
      botResponse: llmResponse.content,
      tier: decision.tier,
      category: decision.category || '',
    });

    if (quality.score < 60) {
      shouldReflect = true;
      notes.push('Low quality response (score: ' + quality.score + ') — ' + quality.issues.join('; '));
    }
  }

  // 4. Tool execution patterns
  if (llmResponse && llmResponse.type === 'tool') {
    notes.push('Tool executed: ' + llmResponse.name + ' — track success/failure');
  }

  // Store reflection notes in working memory
  if (notes.length > 0) {
    workingMemory.update(userId, {
      contextNotes: 'Reflection: ' + notes.join(' | '),
    });
  }

  return { shouldReflect, reflectionNotes: notes };
}

// ── 3. Proactive Suggestion Engine ──────────────────────────────────────────

/**
 * Generate a proactive suggestion for the bot to initiate conversation.
 * Based on: time of day, user patterns, active plans, mood history.
 * 
 * @param {string} userId
 * @param {object} wm - working memory state
 * @param {object} intent - current intent
 * @returns {{shouldProact: boolean, message: string, reason: string, priority: number}|null}
 */
function generateProactiveSuggestion(userId, wm, intent) {
  const suggestions = [];
  const hour = new Date().getHours();

  // ── Suggestion 1: Morning check-in ────────────────────────────────────
  if (hour >= 6 && hour <= 9) {
    suggestions.push({
      message: '☀️ Selamat pagi! Ada plan untuk hari ni? Nak saya tolong setkan reminder atau jadual?',
      reason: 'Morning check-in',
      priority: 3,
    });
  }

  // ── Suggestion 2: Mid-day productivity nudge ──────────────────────────
  if (hour >= 11 && hour <= 13) {
    suggestions.push({
      message: '🕐 Dah tengah hari! Macam mana progress hari ni? Ada apa-apa nak saya bantu?',
      reason: 'Mid-day check-in',
      priority: 5,
    });
  }

  // ── Suggestion 3: Evening reflection ──────────────────────────────────
  if (hour >= 20 && hour <= 22) {
    suggestions.push({
      message: '🌙 Dah malam! Nak saya generate reflection untuk hari ni? Atau nak plan untuk esok?',
      reason: 'Evening reflection prompt',
      priority: 4,
    });
  }

  // ── Suggestion 4: Task/goal follow-up ─────────────────────────────────
  if (wm.currentGoal) {
    suggestions.push({
      message: '📋 Saya perasan ada goal aktif: "' + wm.currentGoal.slice(0, 80) + '". Nak sambung kerja atau nak saya tolong track progress?',
      reason: 'Active goal follow-up',
      priority: 8,
    });
  }

  // ── Suggestion 5: Stalled plan reminder ───────────────────────────────
  const planner = require('./planner');
  const stalledPlans = planner.getStalledPlans(userId, 12);
  if (stalledPlans.length > 0) {
    const plan = stalledPlans[0];
    suggestions.push({
      message: '⏰ Plan "' + plan.goal.slice(0, 60) + '" dah ' +
        Math.round((Date.now() - new Date(plan.updatedAt).getTime()) / 3600000) +
        ' jam tak update. Nak sambung ke nak adjust plan?',
      reason: 'Stalled plan reminder',
      priority: 9,
    });
  }

  // ── Suggestion 6: Mood-based check-in ─────────────────────────────────
  if (intent && intent.mood === 'tired') {
    suggestions.push({
      message: '😴 Nampak macam penat je hari ni. Jangan lupa rehat cukup ya. Ada apa-apa yang saya boleh bantu ringankan?',
      reason: 'Tired mood support',
      priority: 6,
    });
  }

  // ── Suggestion 7: Learning interest ───────────────────────────────────
  if (wm.currentGoal && wm.currentGoal.toLowerCase().includes('belajar')) {
    suggestions.push({
      message: '📚 Nak saya carikan resources atau buatkan study plan untuk "' + wm.currentGoal.slice(0, 60) + '"?',
      reason: 'Learning support',
      priority: 7,
    });
  }

  // Sort by priority (highest first)
  suggestions.sort((a, b) => b.priority - a.priority);

  if (suggestions.length === 0) return null;

  // Don't suggest if we just suggested recently (within last 30 min)
  // This is tracked via working memory
  const lastProactive = wm.contextNotes || '';
  if (lastProactive.includes('PROACTIVE_SENT') && wm.lastUpdated) {
    const minutesSince = (Date.now() - wm.lastUpdated.getTime()) / 60000;
    if (minutesSince < 30) return null;
  }

  return {
    shouldProact: true,
    ...suggestions[0],
  };
}

// ── 4. Learning Tracker ────────────────────────────────────────────────────

/**
 * Track what types of interactions work well vs poorly.
 * Simple in-memory stats for improvement over time.
 */
const interactionStats = new Map(); // userId → stats

function getStats(userId) {
  if (!interactionStats.has(userId)) {
    interactionStats.set(userId, {
      totalInteractions: 0,
      byTier: { fast: 0, medium: 0, deep: 0 },
      byCategory: {},
      qualityScores: [],
      avgQuality: 0,
      toolSuccessRate: {},
      lastReset: new Date().toISOString(),
    });
  }
  return interactionStats.get(userId);
}

/**
 * Record a completed interaction for learning.
 */
function recordInteraction(userId, { tier, category, quality, toolName, toolSuccess }) {
  const stats = getStats(userId);
  stats.totalInteractions++;

  // Track by tier
  if (stats.byTier[tier] !== undefined) stats.byTier[tier]++;

  // Track by category
  if (category) {
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
  }

  // Track quality
  if (quality !== undefined) {
    stats.qualityScores.push(quality);
    if (stats.qualityScores.length > 100) stats.qualityScores.shift();
    stats.avgQuality = Math.round(
      stats.qualityScores.reduce((a, b) => a + b, 0) / stats.qualityScores.length
    );
  }

  // Track tool success
  if (toolName) {
    if (!stats.toolSuccessRate[toolName]) {
      stats.toolSuccessRate[toolName] = { success: 0, fail: 0 };
    }
    if (toolSuccess) {
      stats.toolSuccessRate[toolName].success++;
    } else {
      stats.toolSuccessRate[toolName].fail++;
    }
  }
}

/**
 * Get a learning summary for self-improvement context.
 */
function getLearningSummary(userId) {
  const stats = getStats(userId);
  if (stats.totalInteractions === 0) return '';

  const parts = [];
  parts.push('📊 INTERACTION STATS');
  parts.push('Total: ' + stats.totalInteractions + ' | Avg Quality: ' + stats.avgQuality + '%');
  parts.push('Tiers: Fast=' + stats.byTier.fast + ' Med=' + stats.byTier.medium + ' Deep=' + stats.byTier.deep);

  // Most common categories
  const topCategories = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, count]) => cat + '(' + count + ')');

  if (topCategories.length > 0) {
    parts.push('Top categories: ' + topCategories.join(', '));
  }

  // Tool reliability
  const toolStats = Object.entries(stats.toolSuccessRate)
    .map(([tool, rates]) => {
      const total = rates.success + rates.fail;
      const rate = total > 0 ? Math.round((rates.success / total) * 100) : 100;
      return tool + ': ' + rate + '%';
    });

  if (toolStats.length > 0) {
    parts.push('Tools: ' + toolStats.join(' | '));
  }

  return parts.join('\n');
}

module.exports = {
  evaluateResponseQuality,
  fastReflection,
  generateProactiveSuggestion,
  recordInteraction,
  getLearningSummary,
  getStats,
};
