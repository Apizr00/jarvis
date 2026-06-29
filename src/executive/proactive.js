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

/**
 * Check if we can send a proactive message of this type.
 */
function canSendProactive(userId, type) {
  const key = userId + ':' + type;
  const lastSent = lastProactiveSent.get(key);
  if (!lastSent) return true;

  const cooldown = COOLDOWNS[type] || COOLDOWNS.general;
  return (Date.now() - lastSent) > cooldown;
}

/**
 * Record that we sent a proactive message.
 */
function recordProactiveSent(userId, type) {
  lastProactiveSent.set(userId + ':' + type, Date.now());
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
  const hour = new Date().getHours();
  const dayOfWeek = new Date().getDay(); // 0=Sun, 6=Sat

  // ── 1. Morning check-in ──────────────────────────────────────────────
  if (hour >= 6 && hour <= 9 && canSendProactive(userId, 'morning_checkin')) {
    const name = await db.getUserName(userId) || 'Boss';
    candidates.push({
      type: 'morning_checkin',
      message: '☀️ Selamat pagi, ' + name + '! ☀️\n\n' +
        'Hari ni ' + getDayName(dayOfWeek) + '. Ada apa-apa plan untuk hari ni?\n' +
        'Nak saya check jadual atau setkan reminder?',
      priority: 8,
    });
  }

  // ── 2. Evening reflection ────────────────────────────────────────────
  if (hour >= 20 && hour <= 22 && canSendProactive(userId, 'evening_reflection')) {
    candidates.push({
      type: 'evening_reflection',
      message: '🌙 Dah malam ni! 🌙\n\n' +
        'How was your day today? Nak saya generate reflection ke?\n' +
        'Atau nak plan untuk esok? Just let me know!',
      priority: 7,
    });
  }

  // ── 3. Goal progress check ────────────────────────────────────────────
  if (wm.currentProject && canSendProactive(userId, 'goal_reminder')) {
    const activePlan = planner.getActivePlan(userId);
    if (activePlan) {
      const nextStep = planner.getNextStep(userId, activePlan.planId);
      if (nextStep) {
        candidates.push({
          type: 'goal_reminder',
          message: '📋 Quick check-in on your goal: *' + activePlan.goal + '*\n\n' +
            'Progress: ' + activePlan.progress + '%\n' +
            'Next step: ' + nextStep.description + '\n\n' +
            'Nak saya tolong track atau update progress?',
          priority: 9,
        });
      }
    }
  }

  // ── 4. Stalled tasks ──────────────────────────────────────────────────
  const stalled = planner.getStalledPlans(userId, 12);
  if (stalled.length > 0 && canSendProactive(userId, 'task_nudge')) {
    const plan = stalled[0];
    const hoursStalled = Math.round((Date.now() - new Date(plan.updatedAt).getTime()) / 3600000);
    candidates.push({
      type: 'task_nudge',
      message: '⏰ Hei! Plan ni dah ' + hoursStalled + ' jam tak update:\n\n' +
        '*"' + plan.goal + '"* (' + plan.progress + '%)\n\n' +
        'Nak sambung ke nak adjust? Saya boleh bantu pecahkan task atau setkan reminder.',
      priority: 9,
    });
  }

  // ── 5. Weekend suggestions ────────────────────────────────────────────
  if ((dayOfWeek === 0 || dayOfWeek === 6) && hour >= 10 && hour <= 12 && canSendProactive(userId, 'general')) {
    candidates.push({
      type: 'general',
      message: '🎉 Weekend! Ada plan best ke hari ni?\n\n' +
        'Kalau takde plan, saya boleh suggest:\n' +
        '• Movie recommendations 🎬\n' +
        '• Tempat makan best 🍜\n' +
        '• Activities untuk weekend 🏃\n\n' +
        'Just let me know!',
      priority: 5,
    });
  }

  // ── 6. Learning reminders ─────────────────────────────────────────────
  if (wm.activeDomain === 'learning' && canSendProactive(userId, 'task_nudge')) {
    candidates.push({
      type: 'task_nudge',
      message: '📚 Quick study check! Ada apa-apa topik yang nak saya bantu research atau explain?\n\n' +
        'Saya boleh:\n' +
        '• Cari resources online\n' +
        '• Buatkan study schedule\n' +
        '• Ringkaskan topik kompleks',
      priority: 6,
    });
  }

  // ── 7. Health/fitness reminders ───────────────────────────────────────
  if (wm.activeDomain === 'health' && canSendProactive(userId, 'general')) {
    if (hour >= 7 && hour <= 9) {
      candidates.push({
        type: 'general',
        message: '💪 Morning! Dah exercise ke belum hari ni?\n\nEven quick 10-min stretch helps! Nak saya suggest short workout?',
        priority: 6,
      });
    }
  }

  // ── 8. After-work wind-down ───────────────────────────────────────────
  if (hour >= 18 && hour <= 19 && dayOfWeek >= 1 && dayOfWeek <= 5 && canSendProactive(userId, 'general')) {
    candidates.push({
      type: 'general',
      message: '🏠 Habis kerja! Time to unwind.\n\n' +
        'Nak suggestions untuk lepak petang ni?\n' +
        'Atau nak saya tolong plan untuk esok?',
      priority: 4,
    });
  }

  // Sort by priority (highest first)
  candidates.sort((a, b) => b.priority - a.priority);

  return candidates;
}

/**
 * Get the best proactive message to send right now.
 * @returns {Promise<{type: string, message: string} | null>}
 */
async function getBestProactiveMessage(userId, bot) {
  const candidates = await generateProactiveCandidates(userId, bot);

  if (candidates.length === 0) return null;

  // Only send if highest priority >= 6 (don't spam with low-priority stuff)
  const best = candidates[0];
  if (best.priority < 6) return null;

  // Record so we don't spam
  recordProactiveSent(userId, best.type);

  // Track in working memory
  workingMemory.update(userId, {
    contextNotes: 'PROACTIVE_SENT: ' + best.type + ' at ' + new Date().toISOString(),
  });

  return { type: best.type, message: best.message };
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
        const hour = new Date().getHours();
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
  recordProactiveSent,
};
