// src/scheduler/index.js
// Polls the DB every 30s for due reminders + morning briefing cron
const cron = require('node-cron');
const db = require('../db');
const { dayjs, fmt } = require('../utils/datetime');
const { escapeMd, safeSendMessage } = require('../tools');
const { getWeatherSummary } = require('../tools/weather');
const { getQuote } = require('../tools/quote');

let botInstance = null;

/**
 * Start the reminder scheduler.
 * @param {object} bot - node-telegram-bot-api instance
 */
function startScheduler(bot) {
  botInstance = bot;
  console.log('⏰ Reminder scheduler started (every 30 seconds)');

  // ── Reminder poller: every 30 seconds ──────────────────────────────────
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const due = await db.getPendingReminders();
      for (const reminder of due) {
        await fireReminder(reminder);
      }
    } catch (err) {
      console.error('Scheduler error:', err.message);
    }
  });

  // ── Morning briefing: configurable time (default 8:00 AM) ──────────────
  const briefingTime = process.env.MORNING_BRIEFING_TIME || '7:00';
  const [hour, minute] = briefingTime.split(':').map(n => parseInt(n, 10));
  const cronExpr = `${minute} ${hour} * * *`;
  console.log(`🌅 Morning briefing scheduled for ${briefingTime} daily`);

  cron.schedule(cronExpr, async () => {
    try {
      await sendMorningBriefing();
    } catch (err) {
      console.error('Morning briefing error:', err.message);
    }
  });
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

    await safeSendMessage(botInstance, reminder.user_id, message);

    if (reminder.recurrence) {
      // Recurring: reschedule to next occurrence
      const nextTime = await db.rescheduleRecurring(reminder.id, reminder.recurrence, reminder.remind_at);
      if (nextTime) {
        const nextFormatted = fmt(nextTime, 'ddd, D MMM [at] h:mm A');
        await safeSendMessage(botInstance, reminder.user_id, '🔁 Next occurrence: ' + nextFormatted);
      }
      console.log('Fired recurring reminder #' + reminder.id + ' (' + reminder.recurrence + ') → next: ' + (nextTime || 'N/A'));
    } else {
      // One-shot: mark as sent
      await db.markReminderSent(reminder.id);
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

module.exports = { startScheduler, buildBriefingMessage };
