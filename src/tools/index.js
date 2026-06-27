// src/tools/index.js
// Tool executor - maps LLM tool calls to actual DB operations
const db = require('../db');
const dayjs = require('dayjs');
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
      const remindAt = new Date(args.time);
      if (isNaN(remindAt.getTime())) {
        return 'I couldn\'t parse that time. Can you try again with a clearer time?';
      }
      const recurrence = args.recurrence || null;
      const reminder = await db.createReminder(userId, args.text, remindAt, recurrence);
      const formatted = dayjs(reminder.remind_at).format('ddd, D MMM YYYY [at] h:mm A');
      let reply = 'Got it. I\'ll remind you to *' + escapeMd(args.text) + '* on ' + formatted + '.';
      if (recurrence) {
        const recurrenceLabels = { daily: 'daily', weekly: 'weekly', weekdays: 'every weekday' };
        reply += ' 🔁 This repeats ' + (recurrenceLabels[recurrence] || recurrence) + '.';
      }
      return reply;
    }

    // ── create_event ─────────────────────────────────────────────────────────
    case 'create_event': {
      if (!args.title || !args.time) {
        return 'I need a title and time to create an event.';
      }
      const eventTime = new Date(args.time);
      if (isNaN(eventTime.getTime())) {
        return 'That time didn\'t parse correctly. Please try again.';
      }
      const duration = args.duration_minutes || 60;
      const event = await db.createEvent(userId, args.title, eventTime, duration);
      const formatted = dayjs(event.event_time).format('ddd, D MMM YYYY [at] h:mm A');
      return 'Event added: *' + escapeMd(event.title) + '* on ' + formatted + ' (' + duration + ' min).';
    }

    // ── add_note ─────────────────────────────────────────────────────────────
    case 'add_note': {
      if (!args.content) {
        return 'What did you want me to note down?';
      }
      await db.addNote(userId, args.content);
      return 'Noted. \uD83D\uDCDD';
    }

    // ── get_today ─────────────────────────────────────────────────────────────
    case 'get_today': {
      const [events, reminders] = await Promise.all([
        db.getTodayEvents(userId),
        db.getTodayReminders(userId),
      ]);

      let reply = '*Today\'s Overview* \uD83D\uDCC5\n\n';

      if (events.length === 0 && reminders.length === 0) {
        return reply + 'Nothing scheduled for today. Clean slate!';
      }

      if (events.length > 0) {
        reply += '*Events:*\n';
        events.forEach(e => {
          const t = dayjs(e.event_time).format('h:mm A');
          reply += '\u2022 ' + t + ' \u2014 ' + escapeMd(e.title) + '\n';
        });
        reply += '\n';
      }

      if (reminders.length > 0) {
        reply += '*Reminders:*\n';
        reminders.forEach(r => {
          const t = dayjs(r.remind_at).format('h:mm A');
          reply += '\u2022 ' + t + ' \u2014 ' + escapeMd(r.text) + '\n';
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
      // Invalidate Redis cache so next LLM call picks up the new fact
      redisCache.invalidateFactsCache(userId);
      return 'Got it, I\'ll remember that ' + escapeMd(args.key) + ' is ' + escapeMd(args.value) + '.';
    }

    // ── list_reminders ───────────────────────────────────────────────────────
    case 'list_reminders': {
      const reminders = await db.getUpcomingReminders(userId, 15);
      if (reminders.length === 0) {
        return 'You have no upcoming reminders. 🎉';
      }
      let reply = '*Upcoming Reminders* ⏰\n\n';
      reminders.forEach(r => {
        const t = dayjs(r.remind_at).format('ddd, D MMM [at] h:mm A');
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
      return 'Reminder #' + args.reminder_id + ' cancelled. ❌';
    }

    // ── update_reminder ─────────────────────────────────────────────────────
    case 'update_reminder': {
      if (!args.reminder_id) {
        return 'Which reminder did you want to update? I need an ID.';
      }
      const updates = {};
      if (args.text) updates.text = args.text;
      if (args.time) {
        const newTime = new Date(args.time);
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

      const formatted = dayjs(updated.remind_at).format('ddd, D MMM YYYY [at] h:mm A');
      let reply = 'Updated reminder #' + args.reminder_id + ': *' + escapeMd(updated.text) + '* → ' + formatted;
      if (updated.recurrence) {
        reply += ' 🔁 ' + updated.recurrence;
      }
      return reply + '.';
    }

    default:
      return 'I tried to use a tool called "' + escapeMd(name) + '" but I don\'t know how to do that yet.';
  }
}

module.exports = { executeTool, escapeMd };
