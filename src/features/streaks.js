// src/features/streaks.js
// Daily streak tracking — gamification for habit building
const db = require('../db');
const { fmt } = require('../utils/datetime');

/**
 * Streak type definitions with display info.
 */
const STREAK_TYPES = {
  daily_chat: { icon: '💬', label: 'Daily Chat', desc: 'Sent at least 1 message' },
  task_completed: { icon: '✅', label: 'Task Completed', desc: 'Completed at least 1 task' },
  morning_briefing: { icon: '🌅', label: 'Morning Briefing', desc: 'Read the morning briefing' },
  reflection: { icon: '🧘', label: 'Reflection', desc: 'Did a daily reflection' },
};

/**
 * Record that the user did an activity today.
 * Non-blocking — errors are silently swallowed so streaks never crash the bot.
 * @param {string} userId
 * @param {'daily_chat'|'task_completed'|'morning_briefing'|'reflection'} type
 * @returns {Promise<{current_streak:number, longest_streak:number, isNewDay:boolean}|null>}
 */
async function recordActivity(userId, type) {
  try {
    return await db.recordStreakActivity(userId, type);
  } catch (err) {
    console.error('[Streaks] Failed to record activity:', err.message);
    return null;
  }
}

/**
 * Build a pretty streak status message for display in /streak or briefings.
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function buildStreakMessage(userId) {
  try {
    const streaks = await db.getStreaks(userId);

    if (streaks.length === 0) {
      return '🔥 *Streaks*\n\n' +
        'No streaks yet! Start by:\n' +
        '• Chatting with me daily 💬\n' +
        '• Completing a task ✅\n' +
        '• Reading your morning briefing 🌅\n' +
        '• Doing a daily reflection 🧘';
    }

    let msg = '🔥 *Your Streaks*\n\n';

    // Sort: active (recorded today) first, then by current streak
    const tz = process.env.TIMEZONE || 'UTC';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    const sorted = [...streaks].sort((a, b) => {
      const aToday = a.last_activity_date
        ? new Date(a.last_activity_date).toLocaleDateString('en-CA', { timeZone: tz }) === today
        : false;
      const bToday = b.last_activity_date
        ? new Date(b.last_activity_date).toLocaleDateString('en-CA', { timeZone: tz }) === today
        : false;
      if (aToday !== bToday) return bToday ? 1 : -1;
      return b.current_streak - a.current_streak;
    });

    let totalActive = 0;

    for (const s of sorted) {
      const def = STREAK_TYPES[s.streak_type] || { icon: '📊', label: s.streak_type };
      const isActiveToday = s.last_activity_date
        ? new Date(s.last_activity_date).toLocaleDateString('en-CA', { timeZone: tz }) === today
        : false;

      if (isActiveToday) totalActive++;

      const statusIcon = isActiveToday ? '✅' : '❌';
      const fireBar = buildFireBar(s.current_streak);

      msg += statusIcon + ' ' + def.icon + ' *' + def.label + '*\n';
      msg += '  ' + fireBar + ' ' + s.current_streak + ' day' + (s.current_streak !== 1 ? 's' : '');
      msg += '  (Best: ' + s.longest_streak + ')\n\n';
    }

    // Summary row
    if (totalActive === streaks.length && streaks.length >= 2) {
      msg += '🎯 *Perfect day!* All ' + streaks.length + ' streaks active today.\n';
    } else if (totalActive === 0) {
      msg += '⚠️ *No streaks recorded today.* Don\'t break the chain!';
    }

    return msg;
  } catch (err) {
    console.error('[Streaks] Failed to build message:', err.message);
    return '🔥 *Streaks*\n\nUnable to load streak data right now.';
  }
}

/**
 * Build a one-line compact streak summary for /today or /briefing.
 * @param {string} userId
 * @returns {Promise<string>}
 */
async function buildStreakSummary(userId) {
  try {
    const streaks = await db.getStreaks(userId);

    if (streaks.length === 0) return '';

    const tz = process.env.TIMEZONE || 'UTC';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    const parts = [];
    for (const s of streaks) {
      const def = STREAK_TYPES[s.streak_type];
      if (!def) continue;
      const isActive = s.last_activity_date
        ? new Date(s.last_activity_date).toLocaleDateString('en-CA', { timeZone: tz }) === today
        : false;
      const mark = isActive ? '✅' : '⬜';
      parts.push(mark + def.icon + ' ' + s.current_streak + 'd');
    }

    if (parts.length === 0) return '';

    const totalFire = streaks.reduce((sum, s) => sum + s.current_streak, 0);
    const emoji = totalFire >= 30 ? '🔥' : totalFire >= 14 ? '🔥' : totalFire >= 7 ? '✨' : '💪';

    return emoji + ' *Streaks:* ' + parts.join('  ');
  } catch {
    return '';
  }
}

/**
 * Build a visual fire bar for a streak count.
 * @param {number} count
 * @returns {string}
 */
function buildFireBar(count) {
  if (count >= 100) return '🔥🔥🔥';
  if (count >= 50) return '🔥🔥';
  if (count >= 30) return '🔥';
  if (count >= 14) return '💎';
  if (count >= 7) return '⭐';
  if (count >= 3) return '💪';
  return '🌱';
}

/**
 * Get milestone message if the user just hit one.
 * @param {number} streak
 * @param {'daily_chat'|'task_completed'|'morning_briefing'|'reflection'} type
 * @returns {string|null}
 */
function getMilestoneMessage(streak, type) {
  const def = STREAK_TYPES[type];
  const name = def ? def.icon + ' ' + def.label : type;

  const milestones = {
    3: '🌟 3-day ' + name + ' streak! You\'re building momentum!',
    5: '🔥 5-day ' + name + ' streak! Halfway to a week!',
    7: '🏆 *WEEK STREAK!* 7 days of ' + name + '! That\'s consistency!',
    10: '💎 10-day ' + name + ' streak! You\'re unstoppable!',
    14: '⚡ *TWO WEEKS!* 14-day ' + name + ' streak! Legendary!',
    21: '🧠 21 days — they say it takes 21 days to form a habit. You did it with ' + name + '!',
    30: '👑 *30-DAY STREAK!* A full month of ' + name + '! You\'re in the top 1%!',
    50: '🚀 *50 DAYS!* ' + name + ' streak — this is elite level!',
    60: '🏅 *60 DAYS!* Two months of ' + name + '! Absolutely incredible!',
    90: '🎖️ *90 DAYS!* Three months! ' + name + ' is now part of your identity!',
    100: '💯 *100 DAYS!* Century club for ' + name + '! Legend status!',
    365: '🎊 *ONE YEAR!* 365 days of ' + name + '! You\'ve mastered consistency!',
  };

  if (milestones[streak]) return milestones[streak];

  // Every 100 days
  if (streak > 100 && streak % 100 === 0) {
    return '🎉 *' + streak + ' DAYS!* ' + name + ' streak! Mind-blowing dedication!';
  }

  return null;
}

module.exports = {
  STREAK_TYPES,
  recordActivity,
  buildStreakMessage,
  buildStreakSummary,
  getMilestoneMessage,
};
