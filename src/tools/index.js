// src/tools/index.js
// Tool executor - maps LLM tool calls to actual DB operations
const db = require('../db');
const dayjs = require('dayjs');

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
      const reminder = await db.createReminder(userId, args.text, remindAt);
      const formatted = dayjs(reminder.remind_at).format('ddd, D MMM YYYY [at] h:mm A');
      return 'Got it. I\'ll remind you to *' + args.text + '* on ' + formatted + '.';
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
      return 'Event added: *' + event.title + '* on ' + formatted + ' (' + duration + ' min).';
    }

    // ── add_note ─────────────────────────────────────────────────────────────
    case 'add_note': {
      if (!args.content) {
        return 'What did you want me to note down?';
      }
      await db.addNote(userId, args.content);
      return 'Noted. 📝';
    }

    // ── get_today ─────────────────────────────────────────────────────────────
    case 'get_today': {
      const [events, reminders] = await Promise.all([
        db.getTodayEvents(userId),
        db.getTodayReminders(userId),
      ]);

      let reply = '*Today\'s Overview* 📅\n\n';

      if (events.length === 0 && reminders.length === 0) {
        return reply + 'Nothing scheduled for today. Clean slate!';
      }

      if (events.length > 0) {
        reply += '*Events:*\n';
        events.forEach(e => {
          const t = dayjs(e.event_time).format('h:mm A');
          reply += '• ' + t + ' — ' + e.title + '\n';
        });
        reply += '\n';
      }

      if (reminders.length > 0) {
        reply += '*Reminders:*\n';
        reminders.forEach(r => {
          const t = dayjs(r.remind_at).format('h:mm A');
          reply += '• ' + t + ' — ' + r.text + '\n';
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
      return 'Got it, I\'ll remember that ' + args.key + ' is ' + args.value + '.';
    }

    default:
      return 'I tried to use a tool called "' + name + '" but I don\'t know how to do that yet.';
  }
}

module.exports = { executeTool };
