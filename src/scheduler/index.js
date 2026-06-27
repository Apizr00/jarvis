// src/scheduler/index.js
// Polls the DB every 30s and fires due reminders via Telegram
const cron = require('node-cron');
const db = require('../db');

let botInstance = null;

/**
 * Start the reminder scheduler.
 * @param {object} bot - node-telegram-bot-api instance
 */
function startScheduler(bot) {
  botInstance = bot;
  console.log('⏰ Reminder scheduler started (every 30 seconds)');

  // Run every 30 seconds
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
}

async function fireReminder(reminder) {
  if (!botInstance) return;

  try {
    const message = '⏰ *Reminder:* ' + reminder.text;
    await botInstance.sendMessage(reminder.user_id, message, { parse_mode: 'Markdown' });
    await db.markReminderSent(reminder.id);
    console.log('Fired reminder #' + reminder.id + ' for user ' + reminder.user_id);
  } catch (err) {
    console.error('Failed to send reminder #' + reminder.id + ':', err.message);
  }
}

module.exports = { startScheduler };
