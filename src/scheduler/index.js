// src/scheduler/index.js
// Polls the DB every 30s for due reminders + morning briefing cron
const cron = require('node-cron');
const db = require('../db');
const { dayjs, fmt } = require('../utils/datetime');
const { escapeMd, safeSendMessage } = require('../tools');
const { getWeatherSummary } = require('../tools/weather');
const { getQuote } = require('../tools/quote');

let botInstance = null;

// Track active cron tasks so we can stop & restart them dynamically
let briefingTask = null;
let reviewTask = null;

// Track recently fired reminder IDs to prevent re-firing within the poll window
const recentlyFired = new Map();

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);

/**
 * Start the reminder scheduler.
 * @param {object} bot - node-telegram-bot-api instance
 */
async function startScheduler(bot) {
  botInstance = bot;
  console.log('⏰ Reminder scheduler started (every 30 seconds)');

  // ── Reminder poller: every 30 seconds ──────────────────────────────────
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const due = await db.getPendingReminders();
      for (const reminder of due) {
        // Skip if already fired within last 60 seconds
        if (recentlyFired.has(reminder.id)) {
          const lastFired = recentlyFired.get(reminder.id);
          if (Date.now() - lastFired < 60000) continue;
        }
        recentlyFired.set(reminder.id, Date.now());
        await fireReminder(reminder);
      }
      // Clean up old entries every 5 minutes
      const cutoff = Date.now() - 300000;
      for (const [id, ts] of recentlyFired) {
        if (ts < cutoff) recentlyFired.delete(id);
      }
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  });

  // ── Initial schedule setup from DB (falls back to .env) ────────────────
  await refreshSchedules();
}

/**
 * Refresh morning briefing & weekly review cron schedules.
 * Reads times from DB first, falls back to .env.
 * Can be called after a user changes settings via /setbriefing or /setreview.
 */
async function refreshSchedules() {
  // ── Stop existing tasks ────────────────────────────────────────────────
  if (briefingTask) { briefingTask.stop(); briefingTask = null; }
  if (reviewTask) { reviewTask.stop(); reviewTask = null; }

  // ── Morning Briefing ───────────────────────────────────────────────────
  const briefingTime = await db.getConfig(OWNER_ID, 'morning_briefing_time', 'MORNING_BRIEFING_TIME', '7:00');
  const [hour, minute] = briefingTime.split(':').map(n => parseInt(n, 10));
  if (!isNaN(hour) && !isNaN(minute)) {
    const cronExpr = `${minute} ${hour} * * *`;
    briefingTask = cron.schedule(cronExpr, async () => {
      try {
        await sendMorningBriefing();
      } catch (err) {
        console.error('Morning briefing error:', err.message);
      }
    });
    console.log(`🌅 Morning briefing scheduled for ${briefingTime} daily`);
  }

  // ── Weekly Review ──────────────────────────────────────────────────────
  const reviewTime = await db.getConfig(OWNER_ID, 'weekly_review_time', 'WEEKLY_REVIEW_TIME', '20:00');
  const [revHour, revMinute] = reviewTime.split(':').map(n => parseInt(n, 10));
  if (!isNaN(revHour) && !isNaN(revMinute)) {
    const reviewCronExpr = `${revMinute} ${revHour} * * 0`;
    reviewTask = cron.schedule(reviewCronExpr, async () => {
      try {
        await sendWeeklyReview();
      } catch (err) {
        console.error('Weekly review error:', err.message);
      }
    });
    console.log(`📊 Weekly review scheduled for Sunday at ${reviewTime}`);
  }
}

/**
 * Fire a due reminder. For recurring reminders, reschedule instead of marking sent.
 */
async function fireReminder(reminder) {
  if (!botInstance) return;

  try {
    const timeFormatted = fmt(reminder.remind_at, 'h:mm A');
    const dateFormatted = fmt(reminder.remind_at, 'dddd, D MMM YYYY');
    const recurrenceLabel = { daily: '🔁 Daily', weekly: '🔁 Weekly', weekdays: '🔁 Weekdays' };

    const message =
      '⏰ *Reminder*\n\n' +
      escapeMd(reminder.text) + '\n\n' +
      '📅 ' + dateFormatted + '\n' +
      '🕐 ' + timeFormatted +
      (reminder.recurrence ? '\n' + (recurrenceLabel[reminder.recurrence] || '🔁 ' + reminder.recurrence) : '');

    const inlineKeyboard = [[
      { text: '✅ Done', callback_data: 'dismiss_reminder:' + reminder.id },
      { text: '🔁 Snooze 10m', callback_data: 'snooze_reminder:' + reminder.id },
    ]];

    try {
      await botInstance.sendMessage(reminder.user_id, message, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch {
      await botInstance.sendMessage(reminder.user_id, message, {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }

    if (reminder.recurrence) {
      // Recurring: reschedule to next occurrence
      const nextTime = await db.rescheduleRecurring(reminder.id, reminder.recurrence, reminder.remind_at);
      if (nextTime) {
        const nextFormatted = fmt(nextTime, 'ddd, D MMM [at] h:mm A');
        try {
          await botInstance.sendMessage(reminder.user_id, '🔁 Next occurrence: ' + escapeMd(nextFormatted), { parse_mode: 'Markdown' });
        } catch {
          await botInstance.sendMessage(reminder.user_id, '🔁 Next occurrence: ' + nextFormatted);
        }
      }
      console.log('Fired recurring reminder #' + reminder.id + ' (' + reminder.recurrence + ') → next: ' + (nextTime || 'N/A'));
    } else {
      // One-shot: leave as pending until user dismisses or cancels
      // (don't auto-mark as sent — let the user dismiss via button)
      console.log('Fired reminder #' + reminder.id + ' for user ' + reminder.user_id);
    }
  } catch (err) {
    console.error('Failed to send reminder #' + reminder.id + ':', err.message);
  }
}

/**
 * Build the morning briefing message (pure function, no side effects).
 * @returns {Promise<string>}
 */
async function buildBriefingMessage() {
  const userId = String(process.env.TELEGRAM_OWNER_ID);
  if (!userId) return '';

  const tz = process.env.TIMEZONE || 'UTC';
  const today = fmt(new Date(), 'dddd, D MMMM YYYY');

  const [events, reminders, overdue, userName] = await Promise.all([
    db.getTodayEvents(userId),
    db.getTodayReminders(userId),
    db.getOverdueReminders(userId),
    db.getUserName(userId),
  ]);

  const name = userName || 'Boss';
  let message = '🌅 *Good Morning, ' + escapeMd(name) + '!* Here\'s your briefing for ' + today + ':\n\n';

  // ── Today's events ───────────────────────────────────────────────────
  if (events.length > 0) {
    message += '*📅 Today\'s Events:*\n';
    events.forEach(e => {
      const t = fmt(e.event_time, 'h:mm A');
      message += '• ' + t + ' — ' + escapeMd(e.title) + '\n';
    });
    message += '\n';
  } else {
    message += '*📅 Events:* None scheduled\n\n';
  }

  // ── Today's reminders ────────────────────────────────────────────────
  if (reminders.length > 0) {
    message += '*⏰ Today\'s Reminders:*\n';
    reminders.forEach(r => {
      const t = fmt(r.remind_at, 'h:mm A');
      const recurring = r.recurrence ? ' 🔁' : '';
      message += '• ' + t + ' — ' + escapeMd(r.text) + recurring + '\n';
    });
    message += '\n';
  } else {
    message += '*⏰ Reminders:* None for today\n\n';
  }

  // ── Overdue tasks ────────────────────────────────────────────────────
  if (overdue.length > 0) {
    message += '*⚠️ Overdue:*\n';
    overdue.forEach(r => {
      const t = fmt(r.remind_at, 'MMM D, h:mm A');
      message += '• ' + escapeMd(r.text) + ' _(was due ' + t + ')_\n';
    });
    message += '\n';
  }

  // ── Weather ──────────────────────────────────────────────────────────
  const weather = await getWeatherSummary();
  if (weather) {
    message += '\n' + weather;
  }

  // ── Motivational quote ───────────────────────────────────────────────
  const quote = await getQuote();
  message += '\n' + quote;

  return message;
}

/**
 * Send the morning briefing to the owner (cron-triggered, has botInstance).
 */
async function sendMorningBriefing() {
  if (!botInstance) return;

  try {
    const message = await buildBriefingMessage();
    if (!message) return;
    await safeSendMessage(botInstance, String(process.env.TELEGRAM_OWNER_ID), message);
    console.log('🌅 Morning briefing sent');
  } catch (err) {
    console.error('Morning briefing failed:', err.message);
  }
}

/**
 * Build the weekly review message.
 * Summarizes notes, reminders fired, and upcoming week.
 * @returns {Promise<string>}
 */
async function buildWeeklyReview() {
  const userId = String(process.env.TELEGRAM_OWNER_ID);
  if (!userId) return '';

  const tz = process.env.TIMEZONE || 'UTC';
  const now = dayjs();

  // ── Date ranges ──────────────────────────────────────────────────────
  const startOfWeek = now.startOf('week');  // Sunday 00:00
  const endOfWeek = now.endOf('week');      // Saturday 23:59
  const startOfNextWeek = endOfWeek.add(1, 'second');
  const endOfNextWeek = startOfNextWeek.add(7, 'day');

  const weekLabel = fmt(startOfWeek.toDate(), 'D MMM') + ' – ' + fmt(endOfWeek.toDate(), 'D MMM YYYY');
  const nextWeekLabel = fmt(startOfNextWeek.toDate(), 'D MMM') + ' – ' + fmt(endOfNextWeek.toDate(), 'D MMM YYYY');

  const [notes, weekReminders, nextWeekReminders, userName] = await Promise.all([
    db.getNotesSince(userId, startOfWeek.toISOString()),
    db.getRemindersDueInRange(userId, startOfWeek.toISOString(), endOfWeek.toISOString()),
    db.getUpcomingRemindersNextWeek(userId, startOfNextWeek.toISOString(), endOfNextWeek.toISOString()),
    db.getUserName(userId),
  ]);

  const name = userName || 'Boss';
  let message = '📊 *Weekly Review*\n' + escapeMd(weekLabel) + '\n\n';
  message += 'Hey ' + escapeMd(name) + ', here\'s your week in review:\n\n';

  // ── Notes saved this week ────────────────────────────────────────────
  if (notes.length > 0) {
    message += '*📝 Notes Saved (' + notes.length + '):*\n';
    notes.forEach(n => {
      const date = fmt(n.created_at, 'ddd, D MMM');
      message += '• ' + escapeMd(n.content.length > 60 ? n.content.substring(0, 60) + '…' : n.content) + ' _(' + date + ')_\n';
    });
    message += '\n';
  } else {
    message += '*📝 Notes:* None this week\n\n';
  }

  // ── Reminders this week ──────────────────────────────────────────────
  const fired = weekReminders.filter(r => r.status === 'sent');
  const missed = weekReminders.filter(r => r.status === 'pending');
  const cancelled = weekReminders.filter(r => r.status === 'cancelled');

  if (weekReminders.length > 0) {
    message += '*⏰ Reminders This Week:*\n';
    if (fired.length > 0) {
      message += '✅ *Completed:*\n';
      fired.forEach(r => {
        message += '  • ' + escapeMd(r.text) + '\n';
      });
    }
    if (missed.length > 0) {
      message += '⚠️ *Missed:*\n';
      missed.forEach(r => {
        const t = fmt(r.remind_at, 'ddd, h:mm A');
        message += '  • ' + escapeMd(r.text) + ' _(' + t + ')_\n';
      });
    }
    if (cancelled.length > 0) {
      message += '❌ *Cancelled:* ' + cancelled.length + '\n';
    }
    message += '\n';
  } else {
    message += '*⏰ Reminders:* None this week\n\n';
  }

  // ── Coming next week ─────────────────────────────────────────────────
  if (nextWeekReminders.length > 0) {
    message += '*🔜 Coming Next Week (' + nextWeekLabel + '):*\n';
    nextWeekReminders.forEach(r => {
      const t = fmt(r.remind_at, 'ddd, h:mm A');
      const rec = r.recurrence ? ' 🔁' : '';
      message += '• ' + escapeMd(r.text) + ' — ' + t + rec + '\n';
    });
    message += '\n';
  } else {
    message += '*🔜 Next Week:* Nothing scheduled yet\n\n';
  }

  // ── Stats ────────────────────────────────────────────────────────────
  const totalActions = notes.length + fired.length;
  message += '📈 *This Week\'s Stats:*\n';
  message += '• ' + notes.length + ' notes saved\n';
  message += '• ' + fired.length + ' reminders completed\n';
  if (missed.length > 0) {
    message += '• ' + missed.length + ' missed ⚠️\n';
  }
  message += '\n_Great job! Keep it up next week! 💪_';

  return message;
}

/**
 * Send the weekly review to the owner.
 */
async function sendWeeklyReview() {
  if (!botInstance) return;

  try {
    const message = await buildWeeklyReview();
    if (!message) return;
    await safeSendMessage(botInstance, String(process.env.TELEGRAM_OWNER_ID), message);
    console.log('📊 Weekly review sent');
  } catch (err) {
    console.error('Weekly review failed:', err.message);
  }
}

module.exports = { startScheduler, buildBriefingMessage, buildWeeklyReview, refreshSchedules };
