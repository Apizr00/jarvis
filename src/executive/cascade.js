// src/executive/cascade.js
// ── Smart Follow-Up Cascade (Fasa 5) ───────────────────────────────────────
// After each tool execution, this module determines if there's a natural
// follow-up action the bot should proactively suggest.
//
// Cascade rules are configurable mappings: tool_name → follow-up suggestions.
// Each rule has:
//   - trigger: which tool/action triggers the cascade
//   - condition: optional check before suggesting
//   - suggestion: what to offer the user
//   - priority: 1-10 (higher = more important)
//
// This replaces the hardcoded "smart follow-up" logic in bot/index.js
// with a centralized, maintainable rule system.

const db = require('../db');
const planner = require('./planner');
const workingMemory = require('./working-memory');

// ── Helpers ────────────────────────────────────────────────────────────────

function getCurrentHour() {
  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();
  return parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
}

// ── Cascade Rules ─────────────────────────────────────────────────────────

const CASCADE_RULES = [
  // ── Notes → Reminders ────────────────────────────────────────────────
  {
    trigger: 'add_note',
    condition: async (userId, args) => {
      // Only suggest if note contains time-related words
      const text = (args.content || '').toLowerCase();
      return /(?:esok|tomorrow|lusa|minggu|bulan|pukul|jam|remind|ingat|jangan|lupa|nanti|akan|datang)/i.test(text);
    },
    suggestion: (userId, args) => ({
      type: 'cascade_note_reminder',
      message: '📝 Noted! Nak saya setkan reminder untuk note ni?',
      action: 'ask_reminder_for_note',
      actionArgs: { noteContent: args.content },
    }),
    priority: 8,
    cooldownMs: 30 * 60 * 1000, // 30 min
  },

  // ── Task completion → Celebration / Next task ─────────────────────────
  {
    trigger: 'complete_task',
    condition: async (userId, args) => {
      const tasks = await db.getActiveTasks(userId);
      // Suggest next task if there are more pending
      const pending = tasks.filter(t => t.status === 'pending');
      return pending.length > 0;
    },
    suggestion: async (userId, args) => {
      const tasks = await db.getActiveTasks(userId);
      const pending = tasks.filter(t => t.status === 'pending');
      const nextTask = pending.sort((a, b) => {
        const p = { high: 0, medium: 1, low: 2 };
        return (p[a.priority] || 1) - (p[b.priority] || 1);
      })[0];
      return {
        type: 'cascade_task_next',
        message: '✅ Task completed! 🎉\n\nNext up: *' + (nextTask?.title || 'No more tasks') + '*\nNak start task seterusnya?',
        action: 'suggest_next_task',
        actionArgs: { nextTaskId: nextTask?.id },
      };
    },
    priority: 7,
    cooldownMs: 10 * 60 * 1000,
  },

  // ── Task completion (all done) → Celebrate ────────────────────────────
  {
    trigger: 'complete_task',
    condition: async (userId) => {
      const tasks = await db.getActiveTasks(userId);
      const pending = tasks.filter(t => t.status === 'pending');
      return pending.length === 0;
    },
    suggestion: () => ({
      type: 'cascade_all_done',
      message: '🏆 All tasks done! Amazing work! 🎉\n\nNak saya generate daily reflection ke? Atau plan for tomorrow?',
      action: 'suggest_reflection_or_plan',
    }),
    priority: 9,
    cooldownMs: 30 * 60 * 1000,
  },

  // ── Goal completed → Celebrate + next goal ────────────────────────────
  {
    trigger: 'complete_goal',
    condition: async (userId) => {
      const goals = await db.getActiveGoals(userId);
      return goals.length > 0;
    },
    suggestion: async (userId) => {
      const goals = await db.getActiveGoals(userId);
      return {
        type: 'cascade_goal_next',
        message: '🌟 Goal achieved! You\'re on fire! 🔥\n\n' +
          (goals.length > 0
            ? 'Next active goal: *' + goals[0].title + '* — nak continue?'
            : 'Nak set new goal?'),
        action: 'suggest_next_goal',
      };
    },
    priority: 9,
    cooldownMs: 30 * 60 * 1000,
  },

  // ── Web search → Save as note ─────────────────────────────────────────
  {
    trigger: 'web_search',
    condition: () => true,
    suggestion: (userId, args) => ({
      type: 'cascade_save_search',
      message: '💡 Nak saya simpan hasil search ni sebagai note? Senang nak rujuk nanti.',
      action: 'ask_save_search_as_note',
      actionArgs: { query: args?.query },
    }),
    priority: 5,
    cooldownMs: 15 * 60 * 1000,
  },

  // ── Reminder created → Add note for prep ─────────────────────────────
  {
    trigger: 'create_reminder',
    condition: (userId, args) => {
      const text = (args?.text || '').toLowerCase();
      return /(?:meeting|mesyuarat|exam|peperiksaan|interview|temuduga|presentation|pembentangan|doctor|doktor|appointment)/i.test(text);
    },
    suggestion: (userId, args) => ({
      type: 'cascade_reminder_prep',
      message: '⏰ Reminder set! Nak saya buatkan preparation notes untuk ' + (args?.text || 'event ni') + '?',
      action: 'ask_prep_notes_for_event',
      actionArgs: { eventText: args?.text },
    }),
    priority: 6,
    cooldownMs: 20 * 60 * 1000,
  },

  // ── Plan created → Offer to set first step as task ────────────────────
  {
    trigger: 'create_plan',
    condition: (userId, args) => {
      const plan = planner.getActivePlan(userId);
      return plan && plan.steps && plan.steps.length > 0;
    },
    suggestion: (userId) => {
      const nextStep = planner.getNextStep(
        userId,
        planner.getActivePlan(userId)?.planId
      );
      if (!nextStep) return null;
      return {
        type: 'cascade_plan_first_step',
        message: '📋 Plan created! First step: *' + nextStep.description + '*\nNak saya setkan reminder untuk step pertama?',
        action: 'ask_reminder_for_plan_step',
        actionArgs: { stepDescription: nextStep.description, stepId: nextStep.id },
      };
    },
    priority: 7,
    cooldownMs: 20 * 60 * 1000,
  },

  // ── User mentions problem → Offer to create a plan ────────────────────
  {
    trigger: 'message_contains_problem',
    condition: () => true,
    suggestion: () => ({
      type: 'cascade_problem_plan',
      message: '🤔 Sounds like a challenge. Nak saya bantu pecahkan problem ni jadi action plan?',
      action: 'ask_create_plan_for_problem',
    }),
    priority: 6,
    cooldownMs: 30 * 60 * 1000,
  },

  // ── Memory-aware: User returns after break → Recap ──────────────────
  {
    trigger: 'message_received',
    condition: async (userId, args) => {
      const wm = workingMemory.get(userId);
      const wm_age = Date.now() - wm.lastUpdated.getTime();
      // Only trigger if user was away for 30+ minutes
      return wm_age > 30 * 60 * 1000 && (wm.recentTopics && wm.recentTopics.length > 0);
    },
    suggestion: (userId) => {
      const wm = workingMemory.get(userId);
      const lastTopics = (wm.recentTopics || []).slice(0, 3).join(', ');
      return {
        type: 'cascade_welcome_back',
        message: '👋 Welcome back! Last time kita bincang pasal ' + lastTopics + '. Nak continue?',
        action: 'offer_recap',
      };
    },
    priority: 8,
    cooldownMs: 60 * 60 * 1000, // 1 hour
  },

  // ── Morning routine: User wakes up → Offer briefing ─────────────────
  {
    trigger: 'message_received',
    condition: async (userId, args) => {
      const hour = getCurrentHour();
      // Only trigger in early morning (5-8 AM)
      if (hour < 5 || hour > 8) return false;
      // Check if user just woke up
      const userMsg = (args?.content || '').toLowerCase();
      return /(?:morning|pagi|bangun|wake|subuh|hello|hi|hey)/i.test(userMsg);
    },
    suggestion: () => ({
      type: 'cascade_morning_briefing',
      message: '🌅 Selamat pagi! Nak saya bagitahu briefing untuk hari ni?',
      action: 'offer_morning_briefing',
    }),
    priority: 9,
    cooldownMs: 4 * 60 * 60 * 1000, // 4 hours
  },

  // ── User shares good news → Celebrate + save memory ─────────────────
  {
    trigger: 'message_received',
    condition: async (userId, args) => {
      const userMsg = (args?.content || '').toLowerCase();
      return /(?:done|siap|completed|finish|settle|berjaya|success|achieved|capai|dapat)/i.test(userMsg) &&
        /(?:finally|akhirnya|at last|alhamdulillah|yes|yay|woo)/i.test(userMsg);
    },
    suggestion: (userId, args) => {
      const userMsg = (args?.content || '');
      return {
        type: 'cascade_celebrate',
        message: '🎉 Congrats! That\'s awesome! Nak saya simpan achievement ni as a note untuk kenangan?',
        action: 'offer_save_achievement',
        actionArgs: { achievement: userMsg.slice(0, 100) },
      };
    },
    priority: 7,
    cooldownMs: 60 * 60 * 1000,
  },

  // ── User seems stressed/tired → Offer support ──────────────────────
  {
    trigger: 'message_received',
    condition: async (userId, args) => {
      const userMsg = (args?.content || '').toLowerCase();
      return /(?:tired|penat|letih|stress|tekanan|burnout|overwhelm|tak\s+larat|give\s+up|putus\s+asa)/i.test(userMsg);
    },
    suggestion: () => ({
      type: 'cascade_support',
      message: '😔 Sounds like you\'re having a rough time. Nak saya share quote motivasi ke, atau nak saya suggest some self-care tips?',
      action: 'offer_support',
    }),
    priority: 8,
    cooldownMs: 2 * 60 * 60 * 1000,
  },
];

// ── Cooldown tracking ─────────────────────────────────────────────────────

const lastCascadeSent = new Map(); // `${userId}:${trigger}` → timestamp

function canSendCascade(userId, trigger, cooldownMs) {
  const key = userId + ':' + trigger;
  const lastSent = lastCascadeSent.get(key);
  if (!lastSent) return true;
  return (Date.now() - lastSent) > (cooldownMs || 30 * 60 * 1000);
}

function recordCascadeSent(userId, trigger) {
  lastCascadeSent.set(userId + ':' + trigger, Date.now());
}

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * After a tool is executed, check if any cascade rules match and return
 * the best follow-up suggestion.
 *
 * @param {string} userId
 * @param {string} toolName - the tool that was just executed
 * @param {object} [toolArgs] - arguments passed to the tool
 * @param {string} [userMessage] - the user's original message (for message-based triggers)
 * @returns {Promise<{type: string, message: string, action: string} | null>}
 */
async function getCascadeSuggestion(userId, toolName, toolArgs = {}, userMessage = '') {
  // Find matching rules
  const matchingRules = CASCADE_RULES.filter(r => r.trigger === toolName);

  // Also check message-based triggers
  if (toolName === 'message_received') {
    const problemKeywords = /(?:problem|masalah|issue|stuck|tersekat|tak\s+tahu|confused|tak\s+faham|help|tolong|how\s+(?:do|can|to))/i;
    if (problemKeywords.test(userMessage)) {
      matchingRules.push(...CASCADE_RULES.filter(r => r.trigger === 'message_contains_problem'));
    }
  }

  if (matchingRules.length === 0) return null;

  // Evaluate each rule (respect cooldowns and conditions)
  for (const rule of matchingRules.sort((a, b) => b.priority - a.priority)) {
    // Check cooldown
    if (!canSendCascade(userId, rule.trigger, rule.cooldownMs)) continue;

    // Check condition
    try {
      const conditionMet = await rule.condition(userId, toolArgs);
      if (!conditionMet) continue;
    } catch (err) {
      console.warn('[Cascade] Condition check failed for rule ' + rule.trigger + ':', err.message);
      continue;
    }

    // Get suggestion
    try {
      const suggestion = await rule.suggestion(userId, toolArgs);
      if (!suggestion) continue;

      // Record for cooldown
      recordCascadeSent(userId, rule.trigger);

      console.log('[Cascade] 🔗 Triggered: ' + rule.trigger + ' → ' + suggestion.type);
      return suggestion;
    } catch (err) {
      console.warn('[Cascade] Suggestion generation failed for rule ' + rule.trigger + ':', err.message);
    }
  }

  return null;
}

/**
 * Check if a user message warrants a cascade suggestion (no tool executed).
 * @param {string} userId
 * @param {string} userMessage
 * @returns {Promise<object|null>}
 */
async function getMessageCascade(userId, userMessage) {
  return getCascadeSuggestion(userId, 'message_received', { content: userMessage }, userMessage);
}

module.exports = {
  getCascadeSuggestion,
  getMessageCascade,
  CASCADE_RULES,
};
