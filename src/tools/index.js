// src/tools/index.js
// Tool executor - maps LLM tool calls to actual DB operations
const db = require('../db');
const { dayjs, fmt } = require('../utils/datetime');
const redisCache = require('../redis');

/**
 * Escape special characters for Telegram's Markdown parser.
 * In legacy Markdown mode the reserved chars are: _ * ` [
 * Prefixing each with \\ prevents them being interpreted as formatting.
 */
function escapeMd(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/([_*`\[])/g, '\\$1');
}

/**
 * Safely send a message, falling back to plain text if Markdown parsing fails.
 * Telegram's Markdown parser rejects text with unescaped special characters.
 * @param {object} bot - node-telegram-bot-api instance
 * @param {number|string} chatId
 * @param {string} text
 */
async function safeSendMessage(bot, chatId, text) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (mdErr) {
    // If Markdown fails, send as plain text (no parse_mode)
    try {
      await bot.sendMessage(chatId, text);
    } catch (plainErr) {
      console.error('sendMessage fallback error:', plainErr.message);
      await bot.sendMessage(chatId, 'Something went wrong displaying the result.');
    }
  }
}

/**
 * Parse an ISO-8601 time string in the configured timezone.
 * If the string lacks a timezone offset, it's interpreted as local time (e.g. Asia/Kuala_Lumpur).
 * @param {string} isoString - e.g. "2026-06-27T07:52:00" or "2026-06-27T07:52:00+08:00"
 * @returns {Date}
 */
function parseLocalTime(isoString) {
  // If already has timezone info (+HH:MM, -HH:MM, or Z), parse directly
  if (isoString.match(/[+-]\d{2}:\d{2}$/) || isoString.endsWith('Z')) {
    return new Date(isoString);
  }
  // No timezone — interpret in the configured timezone
  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();
  const offsetParts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(now);
  const offsetStr = offsetParts.find(p => p.type === 'timeZoneName').value; // "GMT+08:00"
  const offset = offsetStr.replace('GMT', ''); // "+08:00"
  return new Date(isoString + offset);
}

/**
 * Execute a tool call returned by the LLM.
 * @param {string} userId
 * @param {{ name: string, args: object }} toolCall
 * @returns {Promise<string>} - human-readable result to send back to user
 */
async function executeTool(userId, toolCall) {
  const { name, args } = toolCall;

  switch (name) {

    // ── create_reminder ──────────────────────────────────────────────────────
    case 'create_reminder': {
      if (!args.text || !args.time) {
        return 'I need both a reminder text and a time to set that up.';
      }
      const remindAt = parseLocalTime(args.time);
      if (isNaN(remindAt.getTime())) {
        return 'I couldn\'t parse that time. Can you try again with a clearer time?';
      }
      const recurrence = args.recurrence || null;
      const reminder = await db.createReminder(userId, args.text, remindAt, recurrence);
      const dateFormatted = fmt(reminder.remind_at, 'dddd, D MMM YYYY');
      const timeFormatted = fmt(reminder.remind_at, 'h:mm A');
      const recurrenceLabel = { daily: '🔁 Repeats daily', weekly: '🔁 Repeats weekly', weekdays: '🔁 Repeats every weekday' };

      let reply =
        '✅ *Reminder set!*\n\n' +
        escapeMd(args.text) + '\n\n' +
        '📅 ' + dateFormatted + '\n' +
        '🕐 ' + timeFormatted;
      if (recurrence) {
        reply += '\n' + (recurrenceLabel[recurrence] || '🔁 ' + recurrence);
      }
      return reply;
    }

    // ── create_event ─────────────────────────────────────────────────────────
    case 'create_event': {
      if (!args.title || !args.time) {
        return 'I need a title and time to create an event.';
      }
      const eventTime = parseLocalTime(args.time);
      if (isNaN(eventTime.getTime())) {
        return 'That time didn\'t parse correctly. Please try again.';
      }
      const duration = args.duration_minutes || 60;
      const event = await db.createEvent(userId, args.title, eventTime, duration);
      const dateFormatted = fmt(event.event_time, 'dddd, D MMM YYYY');
      const timeFormatted = fmt(event.event_time, 'h:mm A');

      return (
        '📅 *Event added!*\n\n' +
        escapeMd(event.title) + '\n\n' +
        '📅 ' + dateFormatted + '\n' +
        '🕐 ' + timeFormatted + '\n' +
        '⏳ ' + duration + ' min'
      );
    }

    // ── add_note ─────────────────────────────────────────────────────────────
    case 'add_note': {
      if (!args.content) {
        return 'What did you want me to note down?';
      }
      await db.addNote(userId, args.content);
      const now = fmt(new Date(), 'ddd, D MMM [at] h:mm A');
      return '📝 *Note saved!*\n\n' + escapeMd(args.content) + '\n\n_' + now + '_';
    }

    // ── get_today ─────────────────────────────────────────────────────────────
    case 'get_today': {
      const [events, reminders] = await Promise.all([
        db.getTodayEvents(userId),
        db.getTodayReminders(userId),
      ]);

      let reply = '*📅 Today\'s Overview*\n\n';

      if (events.length === 0 && reminders.length === 0) {
        return reply + '✨ Nothing scheduled — enjoy your day!';
      }

      if (events.length > 0) {
        reply += '*📅 Events*\n';
        events.forEach(e => {
          const t = fmt(e.event_time, 'h:mm A');
          reply += '• ' + t + ' — ' + escapeMd(e.title) + '\n';
        });
        reply += '\n';
      }

      if (reminders.length > 0) {
        reply += '*⏰ Reminders*\n';
        reminders.forEach(r => {
          const t = fmt(r.remind_at, 'h:mm A');
          reply += '• ' + t + ' — ' + escapeMd(r.text) + '\n';
        });
      }

      return reply.trim();
    }

    // ── set_fact ──────────────────────────────────────────────────────────────
    case 'set_fact': {
      if (!args.key || !args.value) {
        return 'I need both a key and value to remember that.';
      }
      await db.setFact(userId, args.key, args.value);
      redisCache.invalidateFactsCache(userId);
      return '🧠 *Remembered!*\n\n' + escapeMd(args.key) + ' → ' + escapeMd(args.value);
    }

    // ── list_reminders ───────────────────────────────────────────────────────
    case 'list_reminders': {
      const reminders = await db.getUpcomingReminders(userId, 15);
      if (reminders.length === 0) {
        return '✨ You have no upcoming reminders.';
      }
      let reply = '*⏰ Upcoming Reminders*\n\n';
      reminders.forEach(r => {
        const t = fmt(r.remind_at, 'ddd, D MMM [at] h:mm A');
        const recurring = r.recurrence ? ' 🔁' : '';
        reply += '• ' + t + ' — ' + escapeMd(r.text) + recurring + ' _(#' + r.id + ')_\n';
      });
      return reply.trim();
    }

    // ── cancel_reminder ──────────────────────────────────────────────────────
    case 'cancel_reminder': {
      if (!args.reminder_id) {
        return 'Which reminder did you want to cancel? I need an ID.';
      }
      await db.cancelReminder(args.reminder_id);
      return '❌ *Cancelled* — reminder #' + args.reminder_id + ' has been removed.';
    }

    // ── update_reminder ─────────────────────────────────────────────────────
    case 'update_reminder': {
      if (!args.reminder_id) {
        return 'Which reminder did you want to update? I need an ID.';
      }
      const updates = {};
      if (args.text) updates.text = args.text;
      if (args.time) {
        const newTime = parseLocalTime(args.time);
        if (isNaN(newTime.getTime())) {
          return 'I couldn\'t parse that new time. Please try again.';
        }
        updates.remind_at = newTime.toISOString();
      }
      if (args.recurrence !== undefined) updates.recurrence = args.recurrence;

      const updated = await db.updateReminder(args.reminder_id, updates);
      if (!updated) {
        return 'I couldn\'t find reminder #' + args.reminder_id + '. It may have already been cancelled.';
      }

      const dateFormatted = fmt(updated.remind_at, 'dddd, D MMM YYYY');
      const timeFormatted = fmt(updated.remind_at, 'h:mm A');
      const recLabel = updated.recurrence ? '\n🔁 ' + updated.recurrence : '';

      let reply =
        '✏️ *Reminder updated!*\n\n' +
        escapeMd(updated.text) + '\n\n' +
        '📅 ' + dateFormatted + '\n' +
        '🕐 ' + timeFormatted +
        recLabel;
      return reply;
    }

    // ── get_quote ────────────────────────────────────────────────────────────
    case 'get_quote': {
      const { getQuote } = require('./quote');
      return await getQuote();
    }

    // ── web_search ───────────────────────────────────────────────────────────
    case 'web_search': {
      const { webSearch } = require('./search');
      if (!args.query) {
        return 'What would you like me to search for?';
      }
      return await webSearch(args.query);
    }

    // ── get_briefing ─────────────────────────────────────────────────────────
    case 'get_briefing': {
      const { buildBriefingMessage } = require('../scheduler');
      return await buildBriefingMessage();
    }

    // ── get_weekly_review ────────────────────────────────────────────────────
    case 'get_weekly_review': {
      const { buildWeeklyReview } = require('../scheduler');
      return await buildWeeklyReview();
    }

    default:
      return 'I tried to use a tool called "' + escapeMd(name) + '" but I don\'t know how to do that yet.';
  }
}

module.exports = { executeTool, escapeMd, safeSendMessage };
