// src/tools/index.js
// Tool executor - maps LLM tool calls to actual DB operations
const db = require('../db');
const { dayjs, fmt } = require('../utils/datetime');
const redisCache = require('../redis');

// ── Tool Parameter Validation ──────────────────────────────────────────────

/**
 * Define required and optional parameters for each tool.
 * This ensures LLM tool calls have all necessary data before execution.
 */
const TOOL_SCHEMAS = {
  create_reminder: {
    required: ['text', 'time'],
    optional: ['recurrence'],
  },
  update_reminder: {
    required: ['reminder_id'],
    optional: ['text', 'time', 'recurrence'],
  },
  cancel_reminder: {
    required: ['reminder_id'],
    optional: [],
  },
  list_reminders: {
    required: [],
    optional: [],
  },
  create_event: {
    required: ['title', 'time'],
    optional: ['duration_minutes'],
  },
  update_event: {
    required: ['event_id'],
    optional: ['title', 'time', 'duration_minutes'],
  },
  cancel_event: {
    required: ['event_id'],
    optional: [],
  },
  add_note: {
    required: ['content'],
    optional: [],
  },
  get_today: {
    required: [],
    optional: [],
  },
  get_briefing: {
    required: [],
    optional: [],
  },
  get_quote: {
    required: [],
    optional: [],
  },
  set_fact: {
    required: ['key', 'value'],
    optional: [],
  },
  web_search: {
    required: ['query'],
    optional: [],
  },
  get_weekly_review: {
    required: [],
    optional: [],
  },
  set_config: {
    required: ['key', 'value'],
    optional: [],
  },
  revert_config: {
    required: ['key'],
    optional: [],
  },
  get_current_time: {
    required: [],
    optional: [],
  },
  create_task: {
    required: ['title'],
    optional: ['description', 'priority', 'due_date', 'goal_id'],
  },
  update_task: {
    required: ['task_id'],
    optional: ['title', 'description', 'priority', 'due_date', 'goal_id'],
  },
  start_task: {
    required: ['task_id'],
    optional: [],
  },
  complete_task: {
    required: ['task_id'],
    optional: [],
  },
  cancel_task: {
    required: ['task_id'],
    optional: [],
  },
  list_tasks: {
    required: [],
    optional: ['status'],
  },
  create_goal: {
    required: ['title'],
    optional: ['description', 'target_date'],
  },
  update_goal: {
    required: ['goal_id'],
    optional: ['title', 'description', 'progress', 'target_date'],
  },
  complete_goal: {
    required: ['goal_id'],
    optional: [],
  },
  abandon_goal: {
    required: ['goal_id'],
    optional: [],
  },
  list_goals: {
    required: [],
    optional: [],
  },
  save_relationship: {
    required: ['name'],
    optional: ['relationship', 'context', 'notes'],
  },
  list_people: {
    required: [],
    optional: [],
  },
};

/**
 * Validate a tool call has all required parameters.
 * Returns { valid: boolean, error?: string }
 */
function validateToolCall(toolName, args) {
  const schema = TOOL_SCHEMAS[toolName];

  if (!schema) {
    console.warn('[Tools] ⚠️ Unknown tool:', toolName);
    return { valid: false, error: 'Unknown tool: ' + toolName };
  }

  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Tool "' + toolName + '" requires parameters' };
  }

  // Check all required params are present and not empty
  const missing = [];
  for (const param of schema.required) {
    const value = args[param];
    if (value === undefined || value === null || value === '') {
      missing.push(param);
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      error: 'Tool "' + toolName + '" is missing required parameters: ' + missing.join(', '),
    };
  }

  // Type validation for specific parameters
  if (args.reminder_id !== undefined && (isNaN(args.reminder_id) || args.reminder_id <= 0)) {
    return { valid: false, error: 'Invalid reminder_id' };
  }
  if (args.event_id !== undefined && (isNaN(args.event_id) || args.event_id <= 0)) {
    return { valid: false, error: 'Invalid event_id' };
  }
  if (args.task_id !== undefined && (isNaN(args.task_id) || args.task_id <= 0)) {
    return { valid: false, error: 'Invalid task_id' };
  }
  if (args.goal_id !== undefined && (isNaN(args.goal_id) || args.goal_id <= 0)) {
    return { valid: false, error: 'Invalid goal_id' };
  }

  return { valid: true };
}

// ── Pending config changes (confirmation flow) ─────────────────────────────
const pendingConfigChanges = new Map();

// ── Dedup guard for set_fact ──────────────────────────────────────────────
// Prevents identical (key, value) from being set twice within a short window.
// Legitimate updates (same key, DIFFERENT value) always pass through.
const recentSetFacts = new Map(); // key: `${userId}::${key}`, value: { value, timestamp }

function isDuplicateSetFact(userId, key, value) {
  const entryKey = userId + '::' + key;
  const recent = recentSetFacts.get(entryKey);
  if (!recent) return false;

  // Same value within 5 seconds → duplicate
  if (recent.value === value && Date.now() - recent.timestamp < 5000) {
    return true;
  }
  return false;
}

function trackSetFact(userId, key, value) {
  const entryKey = userId + '::' + key;
  recentSetFacts.set(entryKey, { value, timestamp: Date.now() });

  // Auto-cleanup after 10 seconds
  setTimeout(() => {
    const current = recentSetFacts.get(entryKey);
    if (current && current.value === value) {
      recentSetFacts.delete(entryKey);
    }
  }, 10000);
}

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
// ── Message deduplication guard ──────────────────────────────────────────
// Prevents sending identical messages to the same chat within a short window.
// This stops the bot from spamming when the LLM or streaming goes haywire.
const recentSentMessages = new Map(); // key: `${chatId}::${hash}`, value: timestamp

function isDuplicateMessage(chatId, text) {
  const key = chatId + '::' + simpleHash(text);
  const lastSent = recentSentMessages.get(key);
  if (lastSent && Date.now() - lastSent < 3000) {
    return true; // sent within last 3 seconds → skip
  }
  recentSentMessages.set(key, Date.now());
  // Clean up old entries periodically
  if (recentSentMessages.size > 200) {
    const cutoff = Date.now() - 10000;
    for (const [k, ts] of recentSentMessages) {
      if (ts < cutoff) recentSentMessages.delete(k);
    }
  }
  return false;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < Math.min(str.length, 200); i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

async function safeSendMessage(bot, chatId, text, fallbackTextOverride = null) {
  // ── Dedup: skip if identical message sent to this chat within 3s ────
  if (isDuplicateMessage(chatId, text)) {
    console.log('[Tools] 🚫 Suppressed duplicate message to chat ' + chatId + ': ' + text.slice(0, 80));
    return false;
  }

  // ── Smart splitting for long messages (> 4000 chars) ──────────────────
  const MAX_LEN = 4000;
  if (text.length <= MAX_LEN) {
    return await sendSingleMessage(bot, chatId, text, fallbackTextOverride);
  }

  // Split into chunks at paragraph boundaries, then sentence if needed
  const chunks = splitLongMessage(text, MAX_LEN);
  console.log('[Tools] 📝 Splitting long message (' + text.length + ' chars) into ' + chunks.length + ' chunks');

  let allSent = true;
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];

    // Add continuation markers
    if (chunks.length > 1) {
      if (i < chunks.length - 1) {
        chunk += '\n\n_(cont\'d…)_';
      }
      if (i > 0) {
        chunk = '_(…continued)_\n\n' + chunk;
      }
    }

    const sent = await sendSingleMessage(bot, chatId, chunk, fallbackTextOverride);
    if (!sent) allSent = false;

    // Small delay between chunks to avoid rate limiting
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return allSent;
}

/**
 * Split a long message into chunks at natural boundaries.
 * Prefers paragraph breaks (\\n\\n), then line breaks (\\n), then sentence breaks.
 * Falls back to hard character split if no natural boundaries found.
 */
function splitLongMessage(text, maxLen) {
  const chunks = [];

  // Reserve some space for continuation markers
  const effectiveMax = maxLen - 50;

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= effectiveMax) {
      chunks.push(remaining);
      break;
    }

    // Try paragraph break first
    let splitAt = remaining.lastIndexOf('\n\n', effectiveMax);
    if (splitAt > effectiveMax * 0.5) {
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt + 2).trim();
      continue;
    }

    // Try single newline
    splitAt = remaining.lastIndexOf('\n', effectiveMax);
    if (splitAt > effectiveMax * 0.5) {
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt + 1).trim();
      continue;
    }

    // Try sentence break (. followed by space)
    splitAt = remaining.lastIndexOf('. ', effectiveMax);
    if (splitAt > effectiveMax * 0.5) {
      chunks.push(remaining.slice(0, splitAt + 1).trim());
      remaining = remaining.slice(splitAt + 2).trim();
      continue;
    }

    // Hard split at maxLen
    chunks.push(remaining.slice(0, effectiveMax).trim());
    remaining = remaining.slice(effectiveMax).trim();
  }

  return chunks;
}

/**
 * Send a single message (no splitting). Tries Markdown first, then plain text.
 */
async function sendSingleMessage(bot, chatId, text, fallbackTextOverride = null) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    return true;
  } catch (mdErr) {
    console.error('[Tools] Markdown send failed (' + mdErr.response?.statusCode + '): ' + mdErr.message + ' | text preview: ' + text.slice(0, 120));
    // If Markdown fails, send as plain text (no parse_mode)
    try {
      await bot.sendMessage(chatId, text);
      return true;
    } catch (plainErr) {
      console.error('[Tools] Plain text send also failed (' + plainErr.response?.statusCode + '): ' + plainErr.message + ' | text length: ' + text.length);
      // Only send the fallback if we haven't already sent it recently
      const fallbackText = fallbackTextOverride || 'Something went wrong displaying the result.';
      if (!isDuplicateMessage(chatId, fallbackText)) {
        try {
          await bot.sendMessage(chatId, fallbackText);
        } catch (fallbackErr) {
          console.error('[Tools] Even fallback message failed:', fallbackErr.message);
        }
      }
      return false;
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

  // ✅ Validate tool call parameters before execution
  const validation = validateToolCall(name, args);
  if (!validation.valid) {
    console.error('[Tools] ❌ Validation failed:', validation.error);
    return '⚠️ ' + validation.error + '. Please check your request and try again.';
  }

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
      // ✅ Validate recurrence value
      const VALID_RECURRENCE = ['daily', 'weekly', 'weekdays'];
      let recurrence = args.recurrence || null;
      if (recurrence !== null && !VALID_RECURRENCE.includes(recurrence)) {
        console.warn('[Tools] ⚠️ Invalid recurrence value ignored:', recurrence);
        recurrence = null;
      }
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

    // ── get_current_time ─────────────────────────────────────────────────────
    case 'get_current_time': {
      const tz = process.env.TIMEZONE || 'UTC';
      const now = new Date();
      const timeFormatted = new Intl.DateTimeFormat('en', {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(now);

      const offsetParts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(now);
      const offsetStr = offsetParts.find(p => p.type === 'timeZoneName').value; // "GMT+08:00"

      return '🕐 Current time: ' + timeFormatted + ' (' + offsetStr + ')';
    }

    // ── set_fact ──────────────────────────────────────────────────────────────
    case 'set_fact': {
      if (!args.key || !args.value) {
        return 'I need both a key and value to remember that.';
      }

      // 🛡️ Dedup guard: skip if identical (key, value) was just set
      if (isDuplicateSetFact(userId, args.key, args.value)) {
        console.log('[Tools] ⏭️  Skipping duplicate set_fact: ' + args.key + ' → ' + args.value);
        // Return same format so the bot doesn't break, but don't hit DB again
        const reply = '🧠 *Remembered!*\n\n' + escapeMd(args.key) + ' → ' + escapeMd(args.value);
        return { type: 'result', tool: 'set_fact', message: reply, meta: { key: args.key, value: args.value } };
      }

      trackSetFact(userId, args.key, args.value);
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

      // ✅ Verify reminder exists before cancelling
      const allReminders = await db.getUpcomingReminders(userId, 50);
      const reminder = allReminders.find(r => r.id === parseInt(args.reminder_id));

      if (!reminder) {
        // List available reminders to help user
        if (allReminders.length === 0) {
          return '🤷‍♂️ You don\'t have any reminders to cancel.';
        }
        let reply = '⚠️ I can\'t find reminder #' + args.reminder_id + '.\n\n*Your reminders:*\n\n';
        allReminders.slice(0, 10).forEach(r => {
          const t = fmt(r.remind_at, 'ddd, D MMM [at] h:mm A');
          reply += '• #' + r.id + ': ' + escapeMd(r.text) + ' — ' + t + '\n';
        });
        return reply.trim();
      }

      await db.cancelReminder(args.reminder_id);
      return '❌ *Cancelled* — reminder #' + args.reminder_id + ' (' + escapeMd(reminder.text) + ') has been removed.';
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

    // ── create_task ──────────────────────────────────────────────────────────
    case 'create_task': {
      if (!args.title) return 'What task would you like to create? I need a title.';
      const dueDate = args.due_date || null;
      const task = await db.createTask(userId, args.title, args.description || '', args.priority || 'medium', dueDate, args.goal_id || null);
      const priorityIcon = { high: '🔴', medium: '🟡', low: '🟢' };
      let reply = '✅ *Task created!*\n\n' + escapeMd(task.title) + '\n📌 ' + (priorityIcon[task.priority] || '') + ' ' + task.priority;
      if (task.due_date) reply += '\n📅 Due: ' + task.due_date;
      return { type: 'result', tool: 'create_task', message: reply, id: task.id, meta: { title: task.title, priority: task.priority, due_date: task.due_date } };
    }
    case 'start_task': {
      if (!args.task_id) return 'Which task? I need a task ID.';
      const task = await db.startTask(args.task_id);
      if (!task) return 'Task #' + args.task_id + ' not found.';
      return '🚀 *Started!* — ' + escapeMd(task.title) + ' is now *In Progress*';
    }
    case 'complete_task': {
      if (!args.task_id) return 'Which task? I need a task ID.';
      const task = await db.completeTask(args.task_id);
      if (!task) return 'Task #' + args.task_id + ' not found.';
      return { type: 'result', tool: 'complete_task', message: '🎉 *Done!* — ' + escapeMd(task.title) + ' completed. Great job! 💪', id: task.id };
    }
    case 'cancel_task': {
      if (!args.task_id) return 'Which task? I need a task ID.';
      const task = await db.cancelTask(args.task_id);
      if (!task) return 'Task #' + args.task_id + ' not found.';
      return '❌ *Cancelled* — ' + escapeMd(task.title);
    }
    case 'list_tasks': {
      const status = args.status || null;
      let tasks;
      if (status && ['pending', 'in_progress', 'done', 'cancelled'].includes(status)) {
        tasks = await db.getTasksByStatus(userId, status);
      } else {
        tasks = await db.getActiveTasks(userId);
      }
      if (tasks.length === 0) return '✨ No ' + (status || 'active') + ' tasks. You\'re all clear!';
      let reply = '*📋 ' + (status ? status.replace('_', ' ').toUpperCase() : 'Active') + ' Tasks*\n\n';
      const statusIcon = { pending: '⬜', in_progress: '🔄', done: '✅', cancelled: '❌' };
      const priorityOrder = { high: 1, medium: 2, low: 3 };
      tasks.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));
      tasks.forEach(t => {
        reply += (statusIcon[t.status] || '•') + ' *' + escapeMd(t.title) + '* [' + t.priority + ']';
        if (t.due_date) reply += ' — 📅 ' + t.due_date;
        reply += ' _(#' + t.id + ')_\n';
      });
      return reply.trim();
    }
    case 'create_goal': {
      if (!args.title) return 'What goal would you like to set? I need a title.';
      const goal = await db.createGoal(userId, args.title, args.description || '', args.target_date || null);
      let reply = '🎯 *Goal set!*\n\n' + escapeMd(goal.title) + '\n📊 Progress: 0%';
      if (goal.target_date) reply += '\n📅 Target: ' + goal.target_date;
      return { type: 'result', tool: 'create_goal', message: reply, id: goal.id, meta: { title: goal.title, target_date: goal.target_date } };
    }
    case 'complete_goal': {
      if (!args.goal_id) return 'Which goal? I need a goal ID.';
      const goal = await db.completeGoal(args.goal_id);
      if (!goal) return 'Goal #' + args.goal_id + ' not found.';
      return '🏆 *Goal achieved!* — ' + escapeMd(goal.title) + ' 100% complete. Congratulations! 🎉';
    }
    case 'abandon_goal': {
      if (!args.goal_id) return 'Which goal? I need a goal ID.';
      const goal = await db.abandonGoal(args.goal_id);
      if (!goal) return 'Goal #' + args.goal_id + ' not found.';
      return '🗑️ *Goal abandoned* — ' + escapeMd(goal.title);
    }
    case 'list_goals': {
      const goals = await db.getAllGoals(userId);
      if (goals.length === 0) return '🎯 No goals set yet. What would you like to achieve?\nTry: "I want to learn Rust" or "My goal is to lose 5kg"';
      let reply = '*🎯 Goals*\n\n';
      goals.forEach(g => {
        const bar = '█'.repeat(Math.round(g.progress / 10)) + '░'.repeat(10 - Math.round(g.progress / 10));
        reply += (g.status === 'completed' ? '✅ ' : g.status === 'abandoned' ? '❌ ' : '🎯 ') + '*' + escapeMd(g.title) + '*\n';
        reply += '  ' + bar + ' ' + g.progress + '%\n';
        if (g.target_date) reply += '  📅 Target: ' + g.target_date + '\n';
        reply += '\n';
      });
      return reply.trim();
    }
    case 'update_task': {
      if (!args.task_id) return 'Which task? I need a task ID.';
      const updates = {};
      if (args.title) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.priority) updates.priority = args.priority;
      if (args.due_date !== undefined) updates.due_date = args.due_date;
      if (args.goal_id !== undefined) updates.goal_id = args.goal_id;
      const task = await db.updateTask(args.task_id, updates);
      if (!task) return 'Task #' + args.task_id + ' not found.';
      return '✏️ *Task updated!* — ' + escapeMd(task.title);
    }
    case 'update_goal': {
      if (!args.goal_id) return 'Which goal? I need a goal ID.';
      const updates = {};
      if (args.title) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.progress !== undefined) updates.progress = args.progress;
      if (args.target_date !== undefined) updates.target_date = args.target_date;
      if (args.status) updates.status = args.status;
      const goal = await db.updateGoal(args.goal_id, updates);
      if (!goal) return 'Goal #' + args.goal_id + ' not found.';
      return '✏️ *Goal updated!* — ' + escapeMd(goal.title) + (goal.progress ? ' (' + goal.progress + '%)' : '');
    }

    // ── save_relationship ──────────────────────────────────────────────────
    case 'save_relationship': {
      if (!args.name) {
        return 'I need a name to remember this person.';
      }
      const person = await db.upsertRelationship(userId, {
        name: args.name,
        relationship: args.relationship || '',
        context: args.context || '',
        notes: args.notes || '',
        confidence: args.confidence || 0.8,
      });

      const relationEmoji = args.relationship
        ? ({ wife: '💍', husband: '💍', spouse: '💍', family: '👪', friend: '🤝', colleague: '💼', boss: '👔', mentor: '🧑‍🏫' })[args.relationship.toLowerCase()]
        : '';
      const emoji = relationEmoji || '👤';

      let reply =
        emoji + ' *' + escapeMd(person.name) + '* remembered!\n\n';
      if (person.relationship) {
        reply += 'Relationship: _' + escapeMd(person.relationship) + '_\n';
      }
      if (person.context) {
        reply += escapeMd(person.context) + '\n';
      }

      return {
        type: 'result',
        tool: 'save_relationship',
        message: reply,
        meta: { name: person.name, relationship: person.relationship },
      };
    }

    // ── list_people ────────────────────────────────────────────────────────
    case 'list_people': {
      const { formatPeopleMessage } = require('../memory/relationships');
      const allPeople = await db.getRelationships(userId, 20);
      return formatPeopleMessage(allPeople, 'People You Know');
    }

    default:
      return 'I tried to use a tool called "' + escapeMd(name) + '" but I don\'t know how to do that yet.';
  }
}

module.exports = { executeTool, escapeMd, safeSendMessage, getPendingConfig, confirmPendingConfig, removePendingConfig, setPendingConfig };
