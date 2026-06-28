// src/tools/index.js
// Tool executor - maps LLM tool calls to actual DB operations
const db = require('../db');
const { dayjs, fmt } = require('../utils/datetime');
const redisCache = require('../redis');

// ── Pending config changes (confirmation flow) ─────────────────────────────
const pendingConfigChanges = new Map();

/**
 * Store a pending config change that requires confirmation.
 * @param {string} userId
 * @param {string} key - DB settings key
 * @param {string} envKey - env var key
 * @param {string} value - new value
 * @param {string} label - human-readable label
 */
function setPendingConfig(userId, key, envKey, value, label) {
  const ts = Date.now();
  pendingConfigChanges.set(userId, { key, envKey, value, label, timestamp: ts });
  // Auto-expire after 5 minutes (only if this exact entry is still the one stored)
  setTimeout(() => {
    const current = pendingConfigChanges.get(userId);
    if (current && current.timestamp === ts) {
      pendingConfigChanges.delete(userId);
    }
  }, 5 * 60 * 1000);
}

function getPendingConfig(userId) {
  const pending = pendingConfigChanges.get(userId);
  if (!pending) return null;
  if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
    pendingConfigChanges.delete(userId);
    return null;
  }
  return pending;
}

function removePendingConfig(userId) {
  pendingConfigChanges.delete(userId);
}

async function confirmPendingConfig(userId) {
  const pending = getPendingConfig(userId);
  if (!pending) return null;
  removePendingConfig(userId);
  // Save current value as "previous" before overwriting (for undo/revert)
  const currentVal = await db.getSetting(userId, pending.key);
  if (currentVal !== null && currentVal !== '') {
    await db.setSetting(userId, 'prev_' + pending.key, currentVal);
  }
  await db.setSetting(userId, pending.key, pending.value);
  return pending;
}

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

      // Return structured object with ID for inline buttons
      return {
        type: 'result',
        tool: 'create_reminder',
        message: reply,
        id: reminder.id,
        meta: { text: args.text, remind_at: reminder.remind_at, recurrence },
      };
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

      const reply =
        '📅 *Event added!*\n\n' +
        escapeMd(event.title) + '\n\n' +
        '📅 ' + dateFormatted + '\n' +
        '🕐 ' + timeFormatted + '\n' +
        '⏳ ' + duration + ' min';

      return {
        type: 'result',
        tool: 'create_event',
        message: reply,
        id: event.id,
        meta: { title: event.title, event_time: event.event_time, duration_minutes: duration },
      };
    }

    // ── update_event ─────────────────────────────────────────────────────────
    case 'update_event': {
      if (!args.event_id) {
        return 'Which event did you want to update? I need an ID.';
      }
      const updates = {};
      if (args.title) updates.title = args.title;
      if (args.time) {
        const newTime = parseLocalTime(args.time);
        if (isNaN(newTime.getTime())) {
          return 'I couldn\'t parse that new time. Please try again.';
        }
        updates.event_time = newTime.toISOString();
      }
      if (args.duration_minutes !== undefined) updates.duration_minutes = args.duration_minutes;

      const updated = await db.updateEvent(args.event_id, updates);
      if (!updated) {
        return 'I couldn\'t find event #' + args.event_id + '. It may have already been removed.';
      }

      const dateFormatted = fmt(updated.event_time, 'dddd, D MMM YYYY');
      const timeFormatted = fmt(updated.event_time, 'h:mm A');

      let reply =
        '✏️ *Event updated!*\n\n' +
        escapeMd(updated.title) + '\n\n' +
        '📅 ' + dateFormatted + '\n' +
        '🕐 ' + timeFormatted + '\n' +
        '⏳ ' + updated.duration_minutes + ' min';

      return {
        type: 'result',
        tool: 'update_event',
        message: reply,
        id: updated.id,
        meta: { title: updated.title, event_time: updated.event_time, duration_minutes: updated.duration_minutes },
      };
    }

    // ── cancel_event ─────────────────────────────────────────────────────────
    case 'cancel_event': {
      if (!args.event_id) {
        return 'Which event did you want to cancel? I need an ID.';
      }
      await db.cancelEvent(args.event_id);
      return '❌ *Cancelled* — event #' + args.event_id + ' has been removed.';
    }

    // ── add_note ─────────────────────────────────────────────────────────────
    case 'add_note': {
      if (!args.content) {
        return 'What did you want me to note down?';
      }
      const note = await db.addNote(userId, args.content);
      const now = fmt(new Date(), 'ddd, D MMM [at] h:mm A');
      const reply = '📝 *Note saved!*\n\n' + escapeMd(args.content) + '\n\n_' + now + '_';
      return {
        type: 'result',
        tool: 'add_note',
        message: reply,
        id: note.id,
        meta: { content: args.content },
      };
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
      const reply = '🧠 *Remembered!*\n\n' + escapeMd(args.key) + ' → ' + escapeMd(args.value);
      return {
        type: 'result',
        tool: 'set_fact',
        message: reply,
        meta: { key: args.key, value: args.value },
      };
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

      return {
        type: 'result',
        tool: 'update_reminder',
        message: reply,
        id: updated.id,
        meta: { text: updated.text, remind_at: updated.remind_at, recurrence: updated.recurrence },
      };
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

    // ── set_config ──────────────────────────────────────────────────────────
    case 'set_config': {
      const validKeys = {
        bot_name: 'BOT_NAME',
        bot_personality: 'BOT_PERSONALITY',
        morning_briefing_time: 'MORNING_BRIEFING_TIME',
        weekly_review_time: 'WEEKLY_REVIEW_TIME',
        weather_location: 'WEATHER_LOCATION',
      };

      // Fuzzy key matching — catch common LLM variations
      const keyAliases = {
        'name': 'bot_name',
        'nama': 'bot_name',
        'botname': 'bot_name',
        'personality': 'bot_personality',
        'personaliti': 'bot_personality',
        'persona': 'bot_personality',
        'perwatakan': 'bot_personality',
        'briefing_time': 'morning_briefing_time',
        'briefing': 'morning_briefing_time',
        'morning_time': 'morning_briefing_time',
        'masa_briefing': 'morning_briefing_time',
        'review_time': 'weekly_review_time',
        'review': 'weekly_review_time',
        'weekly_time': 'weekly_review_time',
        'masa_review': 'weekly_review_time',
        'location': 'weather_location',
        'lokasi': 'weather_location',
        'city': 'weather_location',
        'bandar': 'weather_location',
        'cuaca': 'weather_location',
        'weather': 'weather_location',
      };

      if (!args.key || args.value === undefined) {
        return 'I need both a setting key and value. Try: bot_name, bot_personality, morning_briefing_time, weekly_review_time, weather_location.';
      }

      let key = args.key.toLowerCase().trim();
      // Resolve alias first
      if (keyAliases[key]) key = keyAliases[key];
      // Also try stripping underscores
      if (!validKeys[key]) {
        const stripped = key.replace(/[_\s-]/g, '');
        const matched = Object.keys(validKeys).find(k => k.replace(/_/g, '') === stripped);
        if (matched) key = matched;
      }

      const envKey = validKeys[key];
      if (!envKey) {
        return 'Unknown setting: "' + escapeMd(args.key) + '". Available: bot_name, bot_personality, morning_briefing_time (e.g. "7:00"), weekly_review_time, weather_location.';
      }

      // Validate time formats
      if ((envKey === 'MORNING_BRIEFING_TIME' || envKey === 'WEEKLY_REVIEW_TIME') && !/^\d{1,2}:\d{2}$/.test(args.value)) {
        return 'Time must be in 24h format, e.g. "7:00" or "20:00".';
      }

      const label = {
        bot_name: 'Bot Name',
        bot_personality: 'Bot Personality',
        morning_briefing_time: 'Morning Briefing Time',
        weekly_review_time: 'Weekly Review Time',
        weather_location: 'Weather Location',
      };

      // ── Store pending & ask for confirmation ────────────────────────────
      setPendingConfig(userId, key, envKey, args.value, label[key]);

      const currentVal = await db.getConfig(userId, key, envKey);
      const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal.length > 50 ? currentVal.slice(0, 50) + '…' : currentVal) + '_' : '';

      return {
        type: 'confirm',
        message: '⚙️ *Confirm Change?*\n\n' +
          '*' + label[key] + '* → ' + escapeMd(args.value) + currentStr,
      };
    }

    // ── revert_config ──────────────────────────────────────────────────────
    case 'revert_config': {
      const validKeys = {
        bot_name: 'BOT_NAME', bot_personality: 'BOT_PERSONALITY',
        morning_briefing_time: 'MORNING_BRIEFING_TIME', weekly_review_time: 'WEEKLY_REVIEW_TIME',
        weather_location: 'WEATHER_LOCATION',
      };
      const keyAliases = {
        'name': 'bot_name', 'nama': 'bot_name', 'personality': 'bot_personality',
        'personaliti': 'bot_personality', 'persona': 'bot_personality',
        'briefing': 'morning_briefing_time', 'review': 'weekly_review_time',
        'location': 'weather_location', 'lokasi': 'weather_location', 'cuaca': 'weather_location',
      };

      let key = (args.key || '').toLowerCase().trim();
      if (keyAliases[key]) key = keyAliases[key];
      if (!validKeys[key]) {
        return 'Unknown setting to revert. Try: bot_name, bot_personality, morning_briefing_time, weekly_review_time, weather_location.';
      }

      const prevVal = await db.getSetting(userId, 'prev_' + key);
      if (!prevVal) {
        return 'No previous value saved for ' + key + '. Nothing to revert to.';
      }

      // Save current as prev (allow re-revert), then restore previous
      const currentVal = await db.getSetting(userId, key);
      await db.setSetting(userId, key, prevVal);
      if (currentVal !== null && currentVal !== '') {
        await db.setSetting(userId, 'prev_' + key, currentVal);
      } else {
        // No current to swap — just clear the prev marker
        await db.setSetting(userId, 'prev_' + key, '');
      }

      // Refresh cron if time setting changed
      if (key === 'morning_briefing_time' || key === 'weekly_review_time') {
        try {
          const { refreshSchedules } = require('../scheduler');
          if (typeof refreshSchedules === 'function') await refreshSchedules();
        } catch { /* ignore */ }
      }

      const label = validKeys[key] === 'BOT_NAME' ? 'Bot Name' :
        validKeys[key] === 'BOT_PERSONALITY' ? 'Bot Personality' :
          validKeys[key] === 'MORNING_BRIEFING_TIME' ? 'Morning Briefing Time' :
            validKeys[key] === 'WEEKLY_REVIEW_TIME' ? 'Weekly Review Time' : 'Weather Location';

      return '↩️ *Reverted!*\n\n*' + label + '* → ' + escapeMd(prevVal);
    }

    default:
      return 'I tried to use a tool called "' + escapeMd(name) + '" but I don\'t know how to do that yet.';
  }
}

module.exports = { executeTool, escapeMd, safeSendMessage, getPendingConfig, confirmPendingConfig, removePendingConfig, setPendingConfig };
