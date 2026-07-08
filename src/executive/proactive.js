// src/executive/proactive.js
// ── Proactive Chat Engine (Fasa 5) ─────────────────────────────────────────
// Allows the bot to initiate conversations based on:
//   - Time-based triggers (morning, evening check-ins)
//   - Event-based triggers (task deadlines, reminders due)
//   - Pattern-based triggers (user inactivity, mood patterns)
//   - Smart suggestions (goal progress, learning prompts)
//
// Integrated with the scheduler to send proactive messages at appropriate times.

const db = require('../db');
const { dayjs } = require('../utils/datetime');
const worldModel = require('./world-model');
const planner = require('./planner');
const workingMemory = require('./working-memory');
const lifecycle = require('./lifecycle');
const patterns = require('../patterns');
const relationships = require('../memory/relationships');

// ── Pattern Signal Cache ─────────────────────────────────────────────────
// Avoid hitting DB on every score calculation. Cache for 5 minutes.
const patternSignalCache = new Map(); // userId → { patterns, expiry }
const PATTERN_CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * Get the current hour (0-23) in the configured timezone.
 */
function getCurrentHour() {
  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();
  return parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
}

/**
 * Get the current day of week (0=Sun, 6=Sat) in the configured timezone.
 */
function getCurrentDayOfWeek() {
  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'short' }).format(now);
  return dayMap[weekday];
}

// ── Engagement history (tracks user response to proactive messages) ────────
const engagementHistory = new Map(); // userId → {type → {sent, responded, lastResponse}}

// Track when we last sent each type of proactive message
const lastProactiveSent = new Map(); // userId → { type: timestamp }

const COOLDOWNS = {
  morning_checkin: 4 * 60 * 60 * 1000,    // 4 hours
  evening_reflection: 4 * 60 * 60 * 1000,
  goal_reminder: 2 * 60 * 60 * 1000,      // 2 hours
  task_nudge: 60 * 60 * 1000,             // 1 hour
  mood_support: 30 * 60 * 1000,           // 30 mins
  general: 3 * 60 * 60 * 1000,            // 3 hours
};

// ── Adaptive Cooldown (Item #5: Dynamic Proactive Timing) ──────────────────

async function getDynamicCooldown(userId, type) {
  const baseCooldown = COOLDOWNS[type] || COOLDOWNS.general;
  try {
    const usagePatterns = await patterns.getPatterns(userId, { type: 'usage', minConfidence: 0.4, limit: 10 });
    const isBursty = usagePatterns.some(p => p.name === 'Bursty User' || p.name.includes('Burst'));
    if (isBursty) return Math.round(baseCooldown * 0.7);
  } catch { /* ignore */ }
  const lc = lifecycle.get(userId);
  if (lc && lc.phase === 'active_task') return Math.round(baseCooldown * 1.5);
  return baseCooldown;
}

async function canSendProactive(userId, type) {
  const key = userId + ':' + type;
  const lastSent = lastProactiveSent.get(key);
  if (!lastSent) return true;
  const cooldown = await getDynamicCooldown(userId, type);
  return (Date.now() - lastSent) > cooldown;
}

/**
 * Record that we sent a proactive message.
 */
function recordProactiveSent(userId, type) {
  lastProactiveSent.set(userId + ':' + type, Date.now());
}

// ── Opportunity Scoring System ─────────────────────────────────────────────
// Replaces hardcoded priorities with dynamic scoring based on:
//   userState + timing + pastBehavior + goalProximity
//
// Each dimension contributes 0-25 points → max score = 100.

/**
 * Score user state: mood, active domain, energy, engagement history.
 * @returns {number} 0-25
 */
function scoreUserState(userId) {
  const wm = worldModel.get(userId);
  let score = 12; // baseline

  // Mood signals
  const moodBoosts = {
    motivated: 8, happy: 5, neutral: 0, tired: -3, stressed: -5, angry: -8,
  };
  score += moodBoosts[wm.currentMood] || 0;

  // Active domain — user engaged in a domain = more receptive
  if (wm.activeDomain && wm.activeDomain !== 'general') {
    score += 3;
  }

  // Focus level
  if (wm.focusLevel === 'high') score -= 5; // don't interrupt deep focus
  if (wm.focusLevel === 'low') score += 3;  // user might welcome a nudge

  // Recent engagement — did user respond to last proactive message?
  const eng = engagementHistory.get(userId) || {};
  const recentTypes = Object.values(eng).filter(e =>
    e.lastResponse && Date.now() - e.lastResponse < 24 * 60 * 60_000
  );
  if (recentTypes.length > 0) score += 4; // user engaged recently

  return Math.max(0, Math.min(25, score));
}

/**
 * Score timing: optimal time windows for each message type.
 * @param {string} type - message type
 * @returns {number} 0-25
 */
function scoreTiming(type) {
  const hour = getCurrentHour();
  const dayOfWeek = getCurrentDayOfWeek();

  const optimalWindows = {
    morning_checkin: { hours: [6, 9], score: 22 },
    evening_reflection: { hours: [20, 22], score: 22 },
    goal_reminder: { hours: [9, 18], score: 18, weekdaysOnly: true },
    task_nudge: { hours: [10, 17], score: 18, weekdaysOnly: true },
    mood_support: { hours: [18, 23], score: 15 },
    general: { hours: [9, 21], score: 15 },
  };

  const window = optimalWindows[type];
  if (!window) return 12; // neutral

  let score = 0;

  // Check hour window
  if (hour >= window.hours[0] && hour <= window.hours[1]) {
    // Inside window → score based on how centered
    const center = (window.hours[0] + window.hours[1]) / 2;
    const distance = Math.abs(hour - center);
    const range = (window.hours[1] - window.hours[0]) / 2;
    score = window.score * (1 - distance / (range * 2));
  } else {
    // Outside window → penalty proportional to distance
    const distance = Math.min(
      Math.abs(hour - window.hours[0]),
      Math.abs(hour - window.hours[1])
    );
    score = Math.max(0, window.score - distance * 3);
  }

  // Weekend penalty for weekday-only types
  if (window.weekdaysOnly && (dayOfWeek === 0 || dayOfWeek === 6)) {
    score = Math.max(0, score - 15);
  }

  return Math.round(Math.max(0, Math.min(25, score)));
}

/**
 * Score past behavior with adaptive scoring (Item #8).
 * Adjusts weights based on overall response rate trends across all types.
 */
function scorePastBehavior(userId, type) {
  const eng = engagementHistory.get(userId);
  if (!eng || !eng[type]) return 12;

  const history = eng[type];
  let score = 12;

  if (history.responded > 0) {
    const responseRate = history.responded / Math.max(history.sent || 1, 1);
    score += Math.round(responseRate * 10);

    // Adaptive: check overall response rate across all types
    const allTypes = Object.values(eng);
    const totalSent = allTypes.reduce((s, t) => s + (t.sent || 0), 0);
    const totalResp = allTypes.reduce((s, t) => s + (t.responded || 0), 0);
    if (totalSent >= 5) {
      const overallRate = totalResp / Math.max(totalSent, 1);
      if (overallRate < 0.2) score -= 5;
      if (overallRate > 0.6) score += 3;
    }
  }

  if (history.sent >= 3 && history.responded === 0) score -= 12;
  if (history.lastResponse && Date.now() - history.lastResponse < 24 * 60 * 60_000) score += 5;
  if (history.responded > 10) score -= 2; // diminishing returns

  return Math.max(0, Math.min(25, score));
}

/**
 * Score goal proximity: how close is the user's active goal deadline?
 * @param {string} userId
 * @returns {number} 0-25
 */
function scoreGoalProximity(userId) {
  const activePlan = planner.getActivePlan(userId);
  if (!activePlan) return 0; // no active plan → no proximity score

  let score = 5; // has an active plan

  // Progress-based scoring
  if (activePlan.progress >= 80) score += 8;  // almost done → nudge to finish
  else if (activePlan.progress >= 50) score += 5;
  else if (activePlan.progress < 10) score += 3; // just started → check-in

  // Stalled plan bonus
  const stalledHours = activePlan.updatedAt
    ? Math.round((Date.now() - new Date(activePlan.updatedAt).getTime()) / 3600000)
    : 0;
  if (stalledHours > 24) score += 8;     // stalled > 1 day → urgent nudge
  else if (stalledHours > 6) score += 4; // stalled > 6 hours → soft nudge

  // Has concrete next step → user is engaged
  const nextStep = planner.getNextStep(userId, activePlan.planId);
  if (nextStep) score += 3;

  return Math.min(25, score);
}

// ── Pattern Signal Dimension (Fasa 5 Upgrade) ───────────────────────────────
// Integrates detected patterns from the Pattern Recognition Engine into
// proactive scoring. This makes the bot smarter about WHEN and WHAT to send
// based on learned user behavior.

/**
 * Get cached pattern signals for a user. Refreshes every 5 minutes.
 * Returns a simplified lookup map: { patternName → { confidence, data } }
 * @param {string} userId
 * @returns {Promise<Map<string, object>>}
 */
async function getCachedPatternSignals(userId) {
  const cached = patternSignalCache.get(userId);
  if (cached && cached.expiry > Date.now()) {
    return cached.patterns;
  }

  try {
    const allPatterns = await patterns.getPatterns(userId, {
      minConfidence: 0.3,
      limit: 50,
    });

    const map = new Map();
    for (const p of allPatterns) {
      map.set(p.name, { confidence: p.confidence, data: p.data, type: p.pattern_type });
    }

    patternSignalCache.set(userId, { patterns: map, expiry: Date.now() + PATTERN_CACHE_TTL });
    return map;
  } catch (err) {
    console.warn('[Proactive] Pattern signal fetch failed:', err.message);
    // Return empty map on failure — graceful degradation
    return new Map();
  }
}

/**
 * Score how detected patterns should influence proactive messaging.
 * Positive score = send more of this type. Negative = suppress.
 *
 * Pattern → Proactive Type mappings:
 *   "Task Collector" (low completion)       → +8 task_nudge
 *   "Task Champion" (high completion)       → +3 task_nudge
 *   "Routine Builder" (recurring reminders)  → +5 morning_checkin, evening_reflection
 *   "Avid Note-Taker"                       → +4 general
 *   "Goal Achiever" / "Multi-Goal Juggler"   → +5 goal_reminder
 *   "Activity Spike Today"                   → -10 all (user already engaged)
 *   "Activity Dip"                           → +8 general, task_nudge
 *   "Engagement Decreasing"                  → +5 general
 *   Reminder Focus: [category]               → boost related type
 *   "Peak Hours: [range]"                    → adjust timing outside peak
 *
 * @param {string} userId
 * @param {string} type - proactive message type
 * @returns {Promise<number>} -15 to +15 (clamped)
 */
async function scorePatternSignal(userId, type) {
  const signals = await getCachedPatternSignals(userId);
  if (signals.size === 0) return 0; // no patterns detected yet → neutral

  let score = 0;

  // ── Usage Pattern Signals ────────────────────────────────────────────
  for (const [name, sig] of signals) {
    if (sig.type !== 'usage') continue;

    // Activity spike → user is very engaged, reduce all proactive
    if (name.includes('Activity Spike')) {
      score -= Math.round(sig.confidence * 12);
    }

    // Activity dip → user might need a nudge
    if (name.includes('Activity Dip') || name.includes('Low Activity')) {
      if (type === 'general' || type === 'task_nudge') {
        score += Math.round(sig.confidence * 10);
      }
    }

    // Activity trend decreasing → re-engage
    if (name.includes('Activity Decreasing') || name.includes('Engagement Decreasing')) {
      if (type === 'general' || type === 'goal_reminder') {
        score += Math.round(sig.confidence * 8);
      }
    }

    // Peak hours detected → if current time is NOT peak, boost (user likely free)
    if (name.startsWith('Peak Hours')) {
      const hour = getCurrentHour();
      const peakRange = sig.data?.peak_range || '';
      const [start, end] = peakRange.split('-').map(Number);
      if (!isNaN(start) && !isNaN(end)) {
        const inPeak = hour >= start && hour <= end;
        if (!inPeak) {
          // Outside peak → user might be more receptive
          score += Math.round(sig.confidence * 5);
        }
      }
    }
  }

  // ── Behavior Pattern Signals ─────────────────────────────────────────
  for (const [name, sig] of signals) {
    if (sig.type !== 'behavior') continue;

    // Task management patterns
    if (name === 'Task Collector') {
      // Low completion rate → nudge more about tasks
      if (type === 'task_nudge') score += 8;
      if (type === 'goal_reminder') score += 4;
    }
    if (name === 'Task Champion') {
      // High completion rate → positive reinforcement
      if (type === 'task_nudge') score += 3;
    }

    // Routine/habit patterns
    if (name === 'Routine Builder') {
      // User likes recurring reminders → morning/evening check-ins more welcome
      if (type === 'morning_checkin' || type === 'evening_reflection') {
        score += Math.round(sig.confidence * 6);
      }
    }

    // Note-taking patterns
    if (name === 'Avid Note-Taker') {
      if (type === 'general') score += 4;
    }

    // Goal patterns
    if (name === 'Goal Achiever' || name === 'Multi-Goal Juggler') {
      if (type === 'goal_reminder') score += 5;
    }

    // Reminder category focus → boost related domain messages
    if (name.startsWith('Reminder Focus:')) {
      const category = sig.data?.category?.toLowerCase() || '';
      if (category === 'health' && type === 'general') score += 4;
      if (category === 'work' && (type === 'task_nudge' || type === 'goal_reminder')) score += 4;
      if (category === 'learning' && type === 'task_nudge') score += 3;
      if (category === 'personal' && type === 'general') score += 3;
    }
  }

  // ── Trend Pattern Signals ────────────────────────────────────────────
  for (const [name, sig] of signals) {
    if (sig.type !== 'trend') continue;

    // Task velocity slowing → backlog building
    if (name.includes('Task Velocity') || name.includes('Backlog')) {
      if (type === 'task_nudge') score += Math.round(sig.confidence * 8);
    }

    // Reminder adherence dropping → user might be overwhelmed
    if (name.includes('Reminder Adherence') && sig.data?.adherence_rate < 0.5) {
      if (type === 'goal_reminder') score += Math.round(sig.confidence * 5);
    }

    // Feature adoption → user trying new things, suggest related
    if (name.includes('Feature Adoption')) {
      if (type === 'general') score += 3;
    }
  }

  // ── Topic Pattern Signals ────────────────────────────────────────────
  const wm = worldModel.get(userId);
  for (const [name, sig] of signals) {
    if (sig.type !== 'topic') continue;

    // Top themes align with user's active domain → boost
    if (name.includes('Top Theme') || name.includes('Primary Topic')) {
      const theme = sig.data?.theme?.toLowerCase() || '';
      if (theme === wm.activeDomain || theme === 'health' || theme === 'learning') {
        if (type === 'general' || type === 'task_nudge') {
          score += Math.round(sig.confidence * 4);
        }
      }
    }
  }

  // Clamp to -15..+15 to prevent any single dimension from dominating
  return Math.max(-15, Math.min(15, score));
}

/**
 * Calculate composite opportunity score (0-100) for a proactive message candidate.
 * Combines: user state + timing + past behavior + goal proximity + pattern signals.
 *
 * @param {string} userId
 * @param {string} type - message type
 * @returns {Promise<{total: number, breakdown: object, shouldSend: boolean}>}
 */
async function calculateOpportunityScore(userId, type) {
  const userState = scoreUserState(userId);
  const timing = scoreTiming(type);
  const pastBehavior = scorePastBehavior(userId, type);
  const goalProximity = scoreGoalProximity(userId);
  const patternSignal = await scorePatternSignal(userId, type);

  const total = userState + timing + pastBehavior + goalProximity + patternSignal;

  return {
    total,
    breakdown: { userState, timing, pastBehavior, goalProximity, patternSignal },
    shouldSend: total >= 35, // threshold — only send if reasonably likely to be welcome
  };
}

/**
 * Record that a proactive message was sent (for engagement tracking).
 */
function recordEngagementSent(userId, type) {
  if (!engagementHistory.has(userId)) {
    engagementHistory.set(userId, {});
  }
  const eng = engagementHistory.get(userId);
  if (!eng[type]) {
    eng[type] = { sent: 0, responded: 0, lastResponse: null };
  }
  eng[type].sent++;
}

/**
 * Record that the user responded after a proactive message.
 * Call this when user sends ANY message within 30 min of a proactive message.
 */
function recordEngagementResponse(userId, type) {
  if (!engagementHistory.has(userId)) return;
  const eng = engagementHistory.get(userId);
  if (eng[type]) {
    eng[type].responded++;
    eng[type].lastResponse = Date.now();
  }
}

/**
 * Generate all candidate proactive messages for a user.
 * Returns array of candidates sorted by priority.
 * 
 * @param {string} userId
 * @param {object} [bot] - optional bot instance to check if user is active
 * @returns {Promise<Array<{type: string, message: string, priority: number}>>}
 */
async function generateProactiveCandidates(userId, bot) {
  const candidates = [];
  const wm = worldModel.get(userId);
  const hour = getCurrentHour();
  const dayOfWeek = getCurrentDayOfWeek();
  const name = await db.getUserName(userId) || 'Boss';

  // ── Personalized context (Item #7) ────────────────────────────────────
  let relevantPeople = '';
  try {
    const people = await relationships.getRecentlyMentionedPeople(userId, new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString());
    if (people.length > 0) {
      const topPeople = people.slice(0, 3).map(p => p.name).join(', ');
      relevantPeople = topPeople;
    }
  } catch { /* ignore */ }

  // ── 1. Morning check-in (personalized) ────────────────────────────────
  if (hour >= 6 && hour <= 9 && await canSendProactive(userId, 'morning_checkin')) {
    let msg = '☀️ Selamat pagi, ' + name + '! ☀️\n\nHari ni ' + getDayName(dayOfWeek) + '.';
    if (wm.currentProject) msg += '\n\n📋 Current project: *' + wm.currentProject + '*';
    if (relevantPeople) msg += '\n👥 Recent contacts: ' + relevantPeople;
    msg += '\n\nAda apa-apa plan untuk hari ni? Nak saya check jadual atau setkan reminder?';
    candidates.push({ type: 'morning_checkin', message: msg, priority: 8 });
  }

  // ── 2. Evening reflection (personalized) ──────────────────────────────
  if (hour >= 20 && hour <= 22 && await canSendProactive(userId, 'evening_reflection')) {
    let msg = '🌙 Dah malam ni, ' + name + '! 🌙\n\nHow was your day today?';
    if (wm.currentProject) msg += '\nMade progress on *' + wm.currentProject + '*?';
    msg += '\n\nNak saya generate reflection ke atau plan untuk esok?';
    candidates.push({ type: 'evening_reflection', message: msg, priority: 7 });
  }

  // ── 3. Goal progress check ────────────────────────────────────────────
  if (wm.currentProject && await canSendProactive(userId, 'goal_reminder')) {
    const activePlan = planner.getActivePlan(userId);
    if (activePlan) {
      const nextStep = planner.getNextStep(userId, activePlan.planId);
      if (nextStep) {
        candidates.push({
          type: 'goal_reminder',
          message: '📋 Quick check-in, ' + name + '!\n\nGoal: *' + activePlan.goal + '*\n' +
            'Progress: ' + activePlan.progress + '%\nNext step: ' + nextStep.description + '\n\nNak saya tolong track?',
          priority: 9,
        });
      }
    }
  }

  // ── 4. Stalled tasks ──────────────────────────────────────────────────
  const stalled = planner.getStalledPlans(userId, 12);
  if (stalled.length > 0 && await canSendProactive(userId, 'task_nudge')) {
    const plan = stalled[0];
    const hoursStalled = Math.round((Date.now() - new Date(plan.updatedAt).getTime()) / 3600000);
    candidates.push({
      type: 'task_nudge',
      message: '⏰ Hei ' + name + '! Plan ni dah ' + hoursStalled + ' jam tak update:\n\n' +
        '*"' + plan.goal + '"* (' + plan.progress + '%)\n\nNak sambung ke nak adjust?',
      priority: 9,
    });
  }

  // ── 5. Weekend suggestions ────────────────────────────────────────────
  if ((dayOfWeek === 0 || dayOfWeek === 6) && hour >= 10 && hour <= 12 && await canSendProactive(userId, 'general')) {
    candidates.push({
      type: 'general',
      message: '🎉 Weekend, ' + name + '! Ada plan best ke?\n\n' +
        'Saya boleh suggest:\n• Movie recommendations 🎬\n• Tempat makan best 🍜\n• Activities 🏃',
      priority: 5,
    });
  }

  // ── 6. Learning reminders ─────────────────────────────────────────────
  if (wm.activeDomain === 'learning' && await canSendProactive(userId, 'task_nudge')) {
    candidates.push({
      type: 'task_nudge',
      message: '📚 Quick study check! Ada topik nak saya bantu research atau explain?\n\n' +
        'Saya boleh:\n• Cari resources online\n• Buatkan study schedule\n• Ringkaskan topik kompleks',
      priority: 6,
    });
  }

  // ── 7. Health/fitness reminders ───────────────────────────────────────
  if (wm.activeDomain === 'health' && await canSendProactive(userId, 'general')) {
    if (hour >= 7 && hour <= 9) {
      candidates.push({
        type: 'general',
        message: '💪 Morning ' + name + '! Dah exercise ke belum?\n\nEven quick 10-min stretch helps! Nak saya suggest short workout?',
        priority: 6,
      });
    }
  }

  // ── 8. After-work wind-down ───────────────────────────────────────────
  if (hour >= 18 && hour <= 19 && dayOfWeek >= 1 && dayOfWeek <= 5 && await canSendProactive(userId, 'general')) {
    candidates.push({
      type: 'general',
      message: '🏠 Habis kerja, ' + name + '! Time to unwind.\n\nNak suggestions untuk lepak petang ni?',
      priority: 4,
    });
  }

  // Sort by priority (highest first)
  candidates.sort((a, b) => b.priority - a.priority);

  // ── Lifecycle-aware filtering ────────────────────────────────────────
  const policy = lifecycle.getProactivePolicy(userId);
  const filtered = candidates.filter(c => {
    // Only allow types in the allowed list (or if list is empty, allow all)
    if (policy.allowedTypes.length > 0 && !policy.allowedTypes.includes(c.type)) {
      return false;
    }
    // Suppress explicitly suppressed types
    if (policy.suppressedTypes.includes(c.type)) {
      return false;
    }
    // Apply priority boost/malus
    c.priority += policy.priorityBoost;
    return true;
  });

  return filtered;
}

/**
 * Get the best proactive message to send right now.
 * Uses opportunity scoring for smarter decisions.
 * @returns {Promise<{type: string, message: string, score: number} | null>}
 */
async function getBestProactiveMessage(userId, bot) {
  const candidates = await generateProactiveCandidates(userId, bot);

  if (candidates.length === 0) return null;

  // ── Score each candidate with opportunity scoring (async) ────────────
  const scored = await Promise.all(candidates.map(async (c) => ({
    ...c,
    opportunity: await calculateOpportunityScore(userId, c.type),
  })));

  // Sort by opportunity score (highest first)
  scored.sort((a, b) => b.opportunity.total - a.opportunity.total);

  const best = scored[0];

  // Only send if opportunity score says we should
  if (!best.opportunity.shouldSend) return null;

  // Only send if score >= 35 (reasonable threshold)
  if (best.opportunity.total < 35) return null;

  // Record for cooldown and engagement tracking
  recordProactiveSent(userId, best.type);
  recordEngagementSent(userId, best.type);

  // Track in working memory
  workingMemory.update(userId, {
    contextNotes: 'PROACTIVE_SENT: ' + best.type + ' (opportunity=' + best.opportunity.total + ') at ' + new Date().toISOString(),
  });

  console.log('[Proactive] 📊 Opportunity score: ' + best.opportunity.total +
    ' (state=' + best.opportunity.breakdown.userState +
    ', time=' + best.opportunity.breakdown.timing +
    ', past=' + best.opportunity.breakdown.pastBehavior +
    ', goal=' + best.opportunity.breakdown.goalProximity +
    ', pattern=' + best.opportunity.breakdown.patternSignal + ')');

  return { type: best.type, message: best.message, score: best.opportunity.total };
}

/**
 * Send a proactive message if conditions are right.
 * Called by the scheduler periodically.
 * 
 * @param {object} bot - Telegram bot instance
 * @param {string} userId 
 * @returns {Promise<boolean>} whether a message was sent
 */
async function maybeSendProactiveMessage(bot, userId) {
  try {
    // Check if user was recently active (don't bug them)
    const wm = worldModel.get(userId);
    if (wm.lastActive) {
      const minutesSinceLastActive = (Date.now() - new Date(wm.lastActive).getTime()) / 60000;

      // Don't send if user was active in last 10 minutes
      if (minutesSinceLastActive < 10) return false;

      // Don't send if user was active more than 8 hours ago (probably sleeping/busy)
      // EXCEPT for morning check-in
      if (minutesSinceLastActive > 480) {
        const hour = getCurrentHour();
        if (hour < 6 || hour > 9) return false;
      }
    }

    const result = await getBestProactiveMessage(userId, bot);
    if (!result) return false;

    // Send the message
    const { escapeMd, safeSendMessage } = require('../tools');
    await safeSendMessage(bot, userId, result.message);

    console.log('[Proactive] 📤 Sent proactive message: ' + result.type);
    return true;
  } catch (err) {
    console.warn('[Proactive] Error sending proactive message:', err.message);
    return false;
  }
}

function getDayName(day) {
  const days = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'];
  return days[day] || 'Hari';
}

module.exports = {
  generateProactiveCandidates,
  getBestProactiveMessage,
  maybeSendProactiveMessage,
  canSendProactive,
  getDynamicCooldown,
  recordProactiveSent,
  // Opportunity scoring (Fasa 5 upgrade — 5D + adaptive + personalized)
  calculateOpportunityScore,
  scoreUserState,
  scoreTiming,
  scorePastBehavior,
  scoreGoalProximity,
  scorePatternSignal,
  getCachedPatternSignals,
  recordEngagementSent,
  recordEngagementResponse,
};
