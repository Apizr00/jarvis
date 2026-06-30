// src/executive/lifecycle.js
// ── Conversation Lifecycle Manager ──────────────────────────────────────────
//
// Tracks the user's relationship with the bot through distinct phases.
// Each phase affects how the bot communicates, what it prioritizes, and
// when it initiates proactive messages.
//
// Phases:
//   ONBOARDING     — First interactions, bot introduces itself, learns basics
//   ACTIVE_TASK    — User is working on something, context is hot
//   IDLE           — Casual browsing, no active task
//   DORMANT        — User hasn't messaged in days
//   REACTIVATION   — User returns after being dormant
//
// Phase transitions are driven by:
//   - Message count in current phase
//   - Idle time since last message
//   - Active plans/goals existence
//   - World model state (working, busy, free)

const db = require('../db');
const worldModel = require('./world-model');
const planner = require('./planner');

// ── Phase Definitions ──────────────────────────────────────────────────────

const PHASES = Object.freeze({
  ONBOARDING: 'onboarding',
  ACTIVE_TASK: 'active_task',
  IDLE: 'idle',
  DORMANT: 'dormant',
  REACTIVATION: 'reactivation',
});

const PHASE_CONFIG = {
  [PHASES.ONBOARDING]: {
    name: 'Onboarding',
    icon: '👋',
    description: 'First interactions — bot introduces itself, learns user basics',
    maxMessages: 15,           // exit after 15 messages
    maxIdleMinutes: 120,       // 2 hours idle → move to idle
    proactiveFrequency: 'high', // frequent check-ins
    toneModifier: 'warm and helpful — introduce features gradually',
  },
  [PHASES.ACTIVE_TASK]: {
    name: 'Active Task',
    icon: '🎯',
    description: 'User is working on something — context is hot, minimize distraction',
    maxMessages: Infinity,
    maxIdleMinutes: 60,        // 1 hour idle → task probably abandoned
    proactiveFrequency: 'low', // don't interrupt
    toneModifier: 'focused and task-oriented — prioritize task completion',
  },
  [PHASES.IDLE]: {
    name: 'Idle',
    icon: '💤',
    description: 'Casual browsing — no active task, normal interaction',
    maxMessages: Infinity,
    maxIdleMinutes: 1440,      // 24 hours idle → dormant
    proactiveFrequency: 'medium',
    toneModifier: 'casual and friendly — be helpful but not pushy',
  },
  [PHASES.DORMANT]: {
    name: 'Dormant',
    icon: '😴',
    description: 'User hasn\'t messaged in days — needs re-engagement',
    maxMessages: Infinity,
    maxIdleMinutes: Infinity,
    proactiveFrequency: 'low', // gentle nudge only
    toneModifier: 'welcome-back warmth — acknowledge absence gently',
  },
  [PHASES.REACTIVATION]: {
    name: 'Reactivation',
    icon: '🔄',
    description: 'User returned after dormancy — catch them up',
    maxMessages: 5,            // exit after 5 messages back
    maxIdleMinutes: 30,
    proactiveFrequency: 'medium',
    toneModifier: 'welcoming and informative — summarize what they missed',
  },
};

// ── In-memory store ────────────────────────────────────────────────────────

const lifecycleStore = new Map(); // userId → LifecycleState

class LifecycleState {
  constructor(userId, phase = PHASES.ONBOARDING) {
    this.userId = userId;
    this.phase = phase;
    this.enteredPhaseAt = new Date().toISOString();
    this.messageCountInPhase = 0;
    this.lastMessageAt = new Date().toISOString();
    this.totalMessages = 0;
    this.phaseHistory = [];      // [{phase, from, to}]
    this.metadata = {};          // phase-specific data
  }
}

// ── 1. Get/Create Lifecycle ─────────────────────────────────────────────────

function get(userId) {
  if (!lifecycleStore.has(userId)) {
    lifecycleStore.set(userId, new LifecycleState(userId));
  }
  return lifecycleStore.get(userId);
}

/**
 * Record a user message and re-evaluate the lifecycle phase.
 * Called on every incoming message BEFORE processing.
 *
 * @param {string} userId
 * @returns {{phase: string, previousPhase: string|null, transitioned: boolean, config: object}}
 */
function onMessageReceived(userId) {
  const lc = get(userId);
  const previousPhase = lc.phase;
  const now = Date.now();
  const lastMsgTime = new Date(lc.lastMessageAt).getTime();
  const idleMinutes = (now - lastMsgTime) / 60000;

  lc.messageCountInPhase++;
  lc.totalMessages++;
  lc.lastMessageAt = new Date().toISOString();

  // ── Determine new phase ──────────────────────────────────────────────
  let newPhase = lc.phase;

  // Check for dormancy → reactivation
  if (lc.phase === PHASES.DORMANT && idleMinutes > 0) {
    newPhase = PHASES.REACTIVATION;
  }

  // Check idle thresholds for other phases
  if (lc.phase === PHASES.REACTIVATION && lc.messageCountInPhase >= PHASE_CONFIG[PHASES.REACTIVATION].maxMessages) {
    newPhase = PHASES.IDLE;
  } else if (lc.phase === PHASES.REACTIVATION && idleMinutes < 30) {
    // Stay in reactivation
  } else if (lc.phase === PHASES.ONBOARDING && lc.messageCountInPhase >= PHASE_CONFIG[PHASES.ONBOARDING].maxMessages) {
    newPhase = PHASES.IDLE;
  }

  // Check for active task (user has active plans + recently active)
  if (newPhase === PHASES.IDLE) {
    const activePlan = planner.getActivePlan(userId);
    if (activePlan) {
      newPhase = PHASES.ACTIVE_TASK;
      lc.metadata.activePlanId = activePlan.planId;
    }
  }

  // If no active plan but was in active_task, drop to idle
  if (lc.phase === PHASES.ACTIVE_TASK && newPhase === PHASES.ACTIVE_TASK) {
    const activePlan = planner.getActivePlan(userId);
    if (!activePlan) {
      newPhase = PHASES.IDLE;
      delete lc.metadata.activePlanId;
    }
  }

  // ── Apply transition if changed ──────────────────────────────────────
  const transitioned = newPhase !== previousPhase;
  if (transitioned) {
    lc.phaseHistory.push({
      phase: previousPhase,
      from: lc.enteredPhaseAt,
      to: new Date().toISOString(),
    });
    lc.phase = newPhase;
    lc.enteredPhaseAt = new Date().toISOString();
    lc.messageCountInPhase = 1; // reset count for new phase

    console.log('[Lifecycle] 🔄 Phase transition: ' + previousPhase + ' → ' + newPhase + ' for user ' + userId);
  }

  return {
    phase: lc.phase,
    previousPhase: transitioned ? previousPhase : null,
    transitioned,
    config: PHASE_CONFIG[lc.phase],
  };
}

/**
 * Re-evaluate phase based on idle time (called by scheduler).
 * Does NOT count as a message — just checks if enough time has passed
 * to transition to dormant.
 *
 * @param {string} userId
 * @returns {{phase: string, transitioned: boolean}}
 */
function evaluateIdle(userId) {
  const lc = get(userId);
  const previousPhase = lc.phase;
  const now = Date.now();
  const lastMsgTime = new Date(lc.lastMessageAt).getTime();
  const idleMinutes = (now - lastMsgTime) / 60000;

  const config = PHASE_CONFIG[lc.phase];
  let newPhase = lc.phase;

  // Check if idle time exceeds phase threshold
  if (config.maxIdleMinutes !== Infinity && idleMinutes > config.maxIdleMinutes) {
    if (lc.phase === PHASES.ACTIVE_TASK) {
      newPhase = PHASES.IDLE;
    } else if (lc.phase === PHASES.IDLE || lc.phase === PHASES.ONBOARDING) {
      newPhase = PHASES.DORMANT;
    }
  }

  const transitioned = newPhase !== previousPhase;
  if (transitioned) {
    lc.phaseHistory.push({
      phase: previousPhase,
      from: lc.enteredPhaseAt,
      to: new Date().toISOString(),
    });
    lc.phase = newPhase;
    lc.enteredPhaseAt = new Date().toISOString();
    lc.messageCountInPhase = 0;

    // Update world model
    worldModel.update(userId, {
      lifecyclePhase: newPhase,
    });

    console.log('[Lifecycle] ⏰ Idle transition: ' + previousPhase + ' → ' + newPhase + ' for user ' + userId);
  }

  return { phase: lc.phase, transitioned };
}

// ── 2. Phase-Aware Behavior ────────────────────────────────────────────────

/**
 * Get the proactive messaging policy for the current phase.
 * Returns which message types are allowed and their priority boost/malus.
 *
 * @param {string} userId
 * @returns {{allowedTypes: string[], suppressedTypes: string[], priorityBoost: number}}
 */
function getProactivePolicy(userId) {
  const lc = get(userId);

  switch (lc.phase) {
    case PHASES.ONBOARDING:
      return {
        allowedTypes: ['morning_checkin', 'evening_reflection', 'general'],
        suppressedTypes: ['goal_reminder', 'task_nudge'],
        priorityBoost: 0,
      };

    case PHASES.ACTIVE_TASK:
      return {
        allowedTypes: ['goal_reminder', 'task_nudge'],
        suppressedTypes: ['morning_checkin', 'evening_reflection', 'general', 'mood_support'],
        priorityBoost: -2, // reduce priority — don't interrupt
      };

    case PHASES.IDLE:
      return {
        allowedTypes: ['morning_checkin', 'evening_reflection', 'goal_reminder', 'task_nudge', 'general'],
        suppressedTypes: [],
        priorityBoost: 0,
      };

    case PHASES.DORMANT:
      return {
        allowedTypes: ['general'], // only gentle nudges
        suppressedTypes: ['morning_checkin', 'evening_reflection', 'goal_reminder', 'task_nudge', 'mood_support'],
        priorityBoost: -3, // very low priority
      };

    case PHASES.REACTIVATION:
      return {
        allowedTypes: ['morning_checkin', 'evening_reflection', 'goal_reminder', 'general'],
        suppressedTypes: ['task_nudge'], // don't nag about old tasks
        priorityBoost: +2, // boost priority — user is back!
      };

    default:
      return {
        allowedTypes: [],
        suppressedTypes: [],
        priorityBoost: 0,
      };
  }
}

/**
 * Generate a contextual greeting based on the current lifecycle phase.
 * Used at the start of responses to add phase-appropriate warmth.
 *
 * @param {string} userId
 * @returns {string|null} greeting prefix or null if not needed
 */
function getPhaseGreeting(userId) {
  const lc = get(userId);

  // Only add greeting for phase transitions or special moments
  if (lc.phase === PHASES.REACTIVATION && lc.messageCountInPhase === 1) {
    const idleDays = Math.round(
      (Date.now() - new Date(lc.enteredPhaseAt).getTime()) / (24 * 60 * 60 * 1000)
    );
    if (idleDays >= 1) {
      return '👋 Welcome back! It\'s been ' + idleDays + ' day(s). ';
    }
    return '👋 Hey, welcome back! ';
  }

  if (lc.phase === PHASES.ONBOARDING && lc.messageCountInPhase <= 3) {
    return null; // onboarding messages already have intro context
  }

  return null; // most messages don't need a phase greeting
}

/**
 * Get a summary of the user's lifecycle for display (/lifecycle command).
 *
 * @param {string} userId
 * @returns {string}
 */
function formatLifecycle(userId) {
  const lc = get(userId);
  const config = PHASE_CONFIG[lc.phase];

  let output = '🔄 **Conversation Lifecycle**\n\n';
  output += '**Current phase:** ' + config.icon + ' ' + config.name + '\n';
  output += '**Description:** ' + config.description + '\n';
  output += '**Messages in phase:** ' + lc.messageCountInPhase + '\n';
  output += '**Total messages:** ' + lc.totalMessages + '\n';
  output += '**Entered phase:** ' + new Date(lc.enteredPhaseAt).toLocaleString() + '\n';
  output += '**Last message:** ' + new Date(lc.lastMessageAt).toLocaleString() + '\n';
  output += '**Tone:** ' + config.toneModifier + '\n';
  output += '**Proactive frequency:** ' + config.proactiveFrequency + '\n';

  if (lc.phaseHistory.length > 0) {
    output += '\n**Phase history:**\n';
    const recent = lc.phaseHistory.slice(-5);
    for (const h of recent) {
      const duration = Math.round(
        (new Date(h.to).getTime() - new Date(h.from).getTime()) / (60 * 60 * 1000)
      );
      output += '  • ' + h.phase + ' (' + duration + 'h)\n';
    }
  }

  // Add active plan context if in active_task
  if (lc.phase === PHASES.ACTIVE_TASK && lc.metadata.activePlanId) {
    const plan = planner.getActivePlan(userId);
    if (plan) {
      output += '\n📋 **Active Plan:** ' + plan.goal + ' (' + plan.progress + '%)\n';
    }
  }

  return output;
}

/**
 * Reset lifecycle for a user (for testing or admin).
 */
function reset(userId) {
  lifecycleStore.delete(userId);
  console.log('[Lifecycle] 🔄 Reset lifecycle for user ' + userId);
}

module.exports = {
  PHASES,
  PHASE_CONFIG,
  LifecycleState,
  get,
  onMessageReceived,
  evaluateIdle,
  getProactivePolicy,
  getPhaseGreeting,
  formatLifecycle,
  reset,
};
