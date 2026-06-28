// src/bot/index.js
// Telegram bot - handles all incoming messages
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { dayjs, fmt } = require('../utils/datetime');
const db = require('../db');
const llm = require('../llm');
const tools = require('../tools');
const { escapeMd, safeSendMessage } = tools;
const { getPendingConfig, confirmPendingConfig, removePendingConfig, setPendingConfig } = tools;
const { buildBriefingMessage } = require('../scheduler');
const { getQuote } = require('../tools/quote');
let { refreshSchedules } = require('../scheduler');
const { transcribe, downloadVoiceFile } = require('../llm/whisper');
const { getApiStatus, formatStatusMessage } = require('../api/status');
const memory = require('../memory');

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);

// ── Time hallucination guard ────────────────────────────────────────────────
// LLMs love to make up times. This function scans the bot's reply for any
// time mention that doesn't match the actual current time, and fixes it.
// Supports Malay ("pukul 6:50", "jam 6.50") and English ("6:50 am", "6.50pm").
function fixHallucinatedTime(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();

  // Get current hour and minute in configured timezone
  const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
  const minute = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, minute: '2-digit' }).format(now), 10);
  const actualTotalMins = hour * 60 + minute;

  // Pattern: optional time-word prefix + HH:MM or HH.MM + optional AM/PM/suffix
  const timePattern = /(pukul|jam|dah\s+(?:pukul|jam)\s+|around\s+|about\s+|at\s+|it'?s?\s+|is\s+|now\s+|already\s+)?(\d{1,2})[:.](\d{2})(?!\d)\s*(pagi|am|a\.m\.?|petang|malam|pm|p\.m\.?)?/gi;

  // Collect all replacements (index, oldStr, newStr) to apply from right to left
  const replacements = [];

  let match;
  while ((match = timePattern.exec(text)) !== null) {
    const fullMatch = match[0];
    const prefix = (match[1] || '');
    const matchedHour = parseInt(match[2], 10);
    const matchedMinute = parseInt(match[3], 10);
    const period = (match[4] || '').toLowerCase();

    // Convert to 24h for comparison
    let matched24h = matchedHour;
    if (/(petang|malam|pm|p\.m)/i.test(period)) {
      if (matchedHour !== 12) matched24h = matchedHour + 12;
    } else if (/(pagi|am|a\.m)/i.test(period)) {
      if (matchedHour === 12) matched24h = 0;
    }

    const matchedTotalMins = matched24h * 60 + matchedMinute;
    const diffMins = Math.abs(matchedTotalMins - actualTotalMins);

    // Only fix if > 2 minutes off
    if (diffMins <= 2) continue;

    // Format the correct time
    const correctHour12 = hour % 12 === 0 ? 12 : hour % 12;
    const correctMinStr = minute.toString().padStart(2, '0');
    const separator = fullMatch.includes(':') ? ':' : '.';

    // Preserve original format as much as possible
    let replacement = prefix + correctHour12 + separator + correctMinStr;
    if (period) replacement += ' ' + period;

    replacements.push({ index: match.index, oldStr: fullMatch, newStr: replacement });
  }

  // Also check "tengah hari" / "tengah malam" mentions
  const tengahHariRe = /\btengah\s*hari\b/gi;
  const tengahMalamRe = /\btengah\s*malam\b/gi;
  const isNoon = hour === 12;
  const isMidnight = hour === 0;

  if (!isNoon) {
    while ((match = tengahHariRe.exec(text)) !== null) {
      const correctTime = 'pukul ' + hour + ':' + minute.toString().padStart(2, '0');
      replacements.push({ index: match.index, oldStr: match[0], newStr: correctTime });
    }
  }
  if (!isMidnight) {
    while ((match = tengahMalamRe.exec(text)) !== null) {
      const correctTime = 'pukul ' + hour + ':' + minute.toString().padStart(2, '0');
      replacements.push({ index: match.index, oldStr: match[0], newStr: correctTime });
    }
  }

  if (replacements.length === 0) return text;

  // Sort by index descending so we can replace from right to left
  replacements.sort((a, b) => b.index - a.index);

  let fixed = text;
  for (const r of replacements) {
    const before = fixed.substring(0, r.index);
    const after = fixed.substring(r.index + r.oldStr.length);
    fixed = before + r.newStr + after;
    console.log('[Bot] ⏰ Fixing hallucinated time: "' + r.oldStr + '" → "' + r.newStr + '" (actual=' + hour + ':' + minute.toString().padStart(2, '0') + ')');
  }

  console.log('[Bot] ⏰ Corrected message:', fixed.slice(0, 200));
  return fixed;
}

// Simple in-memory conversation history per user (last 10 turns)
// Populated from DB on startup, kept in sync with DB on every message
const conversationHistory = {};

/**
 * Load recent chat history from DB into in-memory cache.
 * Called once at bot startup to restore context.
 */
async function loadHistoryFromDB(userId) {
  try {
    const rows = await db.getRecentChatHistory(userId, 20);
    if (rows.length > 0) {
      conversationHistory[userId] = rows;
      console.log('[Bot] 📜 Loaded ' + rows.length + ' history messages from DB for user ' + userId);
    }
  } catch (err) {
    console.warn('[Bot] Could not load chat history from DB:', err.message);
  }
}

// Track which item the user is currently editing (set by inline button click)
// Format: { userId: { type: 'reminder'|'event', id: number, label: string, timestamp: number } }
const pendingEdits = {};

function setPendingEdit(userId, type, id, label) {
  pendingEdits[userId] = { type, id, label, timestamp: Date.now() };
  // Auto-expire after 2 minutes
  setTimeout(() => {
    const current = pendingEdits[userId];
    if (current && current.timestamp === pendingEdits[userId]?.timestamp) {
      delete pendingEdits[userId];
    }
  }, 2 * 60 * 1000);
}

function getPendingEdit(userId) {
  const edit = pendingEdits[userId];
  if (!edit) return null;
  if (Date.now() - edit.timestamp > 2 * 60 * 1000) {
    delete pendingEdits[userId];
    return null;
  }
  return edit;
}

function clearPendingEdit(userId) {
  delete pendingEdits[userId];
}

function getHistory(userId) {
  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  return conversationHistory[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  // Keep last 10 messages to avoid huge prompts
  if (history.length > 10) history.splice(0, history.length - 10);

  // 💾 Persist to DB (fire-and-forget — don't block the response)
  db.saveChatMessage(userId, role, content).catch(err => {
    console.warn('[Bot] Failed to persist chat message:', err.message);
  });
}

function clearHistory(userId) {
  delete conversationHistory[userId];
  console.log('[Bot] 🧹 Cleared conversation history for ' + userId);
}

async function createBot() {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  const botName = await db.getConfig(OWNER_ID, 'bot_name', 'BOT_NAME', 'Jarvis');
  console.log('🤖 ' + botName + ' bot is online and polling...');

  // 💾 Restore conversation history from DB on startup
  await loadHistoryFromDB(OWNER_ID);

  // ── Guard: only respond to the owner ──────────────────────────────────────
  function isOwner(msg) {
    const match = String(msg.from.id) === OWNER_ID;
    if (!match) {
      console.log(`⛔ Blocked message from non-owner: ID=${msg.from.id}, Name=${msg.from.first_name}`);
    }
    return match;
  }

  // ── /start command ────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    console.log(`📩 /start from ID=${msg.from.id}, Name=${msg.from.first_name}`);
    if (!isOwner(msg)) {
      await bot.sendMessage(msg.chat.id, '⚠️ Sorry, you are not authorized. Your Telegram user ID is: `' + msg.from.id + '`', { parse_mode: 'Markdown' });
      return;
    }

    try {
      const name = msg.from.first_name || 'Boss';
      await db.ensureUser(OWNER_ID, name);

      const welcome =
        'Hey ' + name + '! I\'m *' + botName + '*, your personal assistant. 🤖\n\n' +
        'You can talk to me naturally. Try:\n' +
        '• "Remind me to call mum at 6pm"\n' +
        '• "Add gym to my calendar tomorrow at 7am"\n' +
        '• "Note: look into React Native"\n' +
        '• "What\'s my schedule today?"\n' +
        '• "Remember that I prefer dark mode"\n\n' +
        'Type /status to check API connections.\n\n' +
        'I\'m ready when you are.';

      await safeSendMessage(bot, msg.chat.id, welcome);
    } catch (err) {
      console.error('/start error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Error: ' + err.message);
    }
  });

  // ── /today command shortcut ───────────────────────────────────────────────
  bot.onText(/\/today/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const result = await tools.executeTool(OWNER_ID, { name: 'get_today', args: {} });
    await safeSendMessage(bot, msg.chat.id, result);
  });

  // ── /notes command shortcut ───────────────────────────────────────────────
  bot.onText(/\/notes/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const notes = await db.getRecentNotes(OWNER_ID, 10);
    if (notes.length === 0) {
      return bot.sendMessage(msg.chat.id, 'No notes saved yet.');
    }
    let reply = '*Recent Notes* 📝\n\n';
    notes.forEach((n, i) => {
      const date = new Date(n.created_at).toLocaleDateString();
      reply += (i + 1) + '\. ' + escapeMd(n.content) + ' \_(' + date + ')\_\n\n';
    });
    await safeSendMessage(bot, msg.chat.id, reply.trim());
  });

  // ── /history command — search past conversations ─────────────────────────
  bot.onText(/\/history(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const query = (match[1] || '').trim();
    const results = await db.searchChatHistory(OWNER_ID, query, 10);

    if (results.length === 0) {
      return bot.sendMessage(msg.chat.id,
        query
          ? 'No past conversations matching "' + escapeMd(query) + '".'
          : 'No chat history yet. Start talking to me!');
    }

    let reply = query
      ? '*🔍 History: "' + escapeMd(query) + '"*\n\n'
      : '*💬 Recent Conversations*\n\n';

    results.forEach(r => {
      const date = fmt(r.created_at, 'MMM D, h:mm A');
      const icon = r.role === 'user' ? '👤' : '🤖';
      const truncated = r.content.length > 80 ? r.content.substring(0, 80) + '…' : r.content;
      reply += icon + ' _' + date + '_:\n' + escapeMd(truncated) + '\n\n';
    });

    try {
      await bot.sendMessage(msg.chat.id, reply.trim(), { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(msg.chat.id, reply.trim());
    }
  });

  // ── /memory command shortcut ──────────────────────────────────────────────
  bot.onText(/\/memory/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const facts = await db.getAllFacts(OWNER_ID);
    if (facts.length === 0) {
      return bot.sendMessage(msg.chat.id, 'No memory facts stored yet.');
    }
    let reply = '*Memory Facts* 🧠\n\n';
    facts.forEach(f => {
      reply += '• *' + escapeMd(f.key) + ':* ' + escapeMd(f.value) + '\n';
    });
    await safeSendMessage(bot, msg.chat.id, reply.trim());
  });

  // ── /verify command — review & resolve conflicting facts ─────────────────
  bot.onText(/\/verify/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const conflicts = await memory.getConflicts(OWNER_ID);
    if (conflicts.length === 0) {
      return bot.sendMessage(msg.chat.id, '✅ No conflicting facts. All memory is consistent!');
    }

    let reply = '*⚠️ Conflicting Facts — Please Review*\n\n';
    const inlineKeyboard = [];

    conflicts.forEach((c, i) => {
      reply += '*' + (i + 1) + '. ' + escapeMd(c.key) + '*\n';
      reply += '  🟢 *Current:* ' + escapeMd(c.value) + ' _(confidence: ' + (c.confidence || '?') + ')_\n';
      if (c.previous_value) {
        reply += '  🔴 *Previous:* ' + escapeMd(c.previous_value) + '\n';
      }
      reply += '\n';

      inlineKeyboard.push([{
        text: '✅ Keep "' + (c.value.length > 15 ? c.value.slice(0, 15) + '…' : c.value) + '"',
        callback_data: 'resolve_conflict:' + encodeURIComponent(c.key) + ':keep_current',
      }]);
      if (c.previous_value) {
        inlineKeyboard.push([{
          text: '↩️ Restore "' + (c.previous_value.length > 15 ? c.previous_value.slice(0, 15) + '…' : c.previous_value) + '"',
          callback_data: 'resolve_conflict:' + encodeURIComponent(c.key) + ':restore_previous',
        }]);
      }
    });

    try {
      await bot.sendMessage(msg.chat.id, reply.trim(), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch {
      await bot.sendMessage(msg.chat.id, reply.trim(), {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }
  });

  // ── /reflect command — generate today's reflection ───────────────────────
  bot.onText(/\/reflect/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');

    try {
      // Check if already generated today
      const existing = await db.getTodayReflection(OWNER_ID);
      if (existing) {
        await safeSendMessage(bot, msg.chat.id, '*🧘 Today\'s Reflection*\n\n' + existing.summary);
        return;
      }

      const reflection = await memory.generateDailyReflection(OWNER_ID, llm.chat);
      if (reflection) {
        await safeSendMessage(bot, msg.chat.id, '*🧘 Today\'s Reflection*\n\n' + reflection);
      } else {
        await bot.sendMessage(msg.chat.id, '📭 Not enough activity today to reflect on. Talk to me more!');
      }
    } catch (err) {
      console.error('/reflect error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate reflection.');
    }
  });

  // ── /tasks command — list active tasks ──────────────────────────────────
  bot.onText(/\/tasks/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const result = await tools.executeTool(OWNER_ID, { name: 'list_tasks', args: {} });
    await safeSendMessage(bot, msg.chat.id, typeof result === 'object' ? result.message : result);
  });

  // ── /goals command — list all goals ─────────────────────────────────────
  bot.onText(/\/goals/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const result = await tools.executeTool(OWNER_ID, { name: 'list_goals', args: {} });
    await safeSendMessage(bot, msg.chat.id, typeof result === 'object' ? result.message : result);
  });

  // ── /reminders command ────────────────────────────────────────────────────
  bot.onText(/\/reminders/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');
    const reminders = await db.getUpcomingReminders(OWNER_ID, 15);

    if (reminders.length === 0) {
      return bot.sendMessage(msg.chat.id, 'You have no upcoming reminders. 🎉');
    }

    let reply = '*Upcoming Reminders* ⏰\n\n';
    const inlineKeyboard = [];

    reminders.forEach(r => {
      const t = fmt(r.remind_at, 'ddd, D MMM [at] h:mm A');
      const recurring = r.recurrence ? ' 🔁' : '';
      reply += '• ' + t + ' — ' + escapeMd(r.text) + recurring + '\n';

      inlineKeyboard.push([{
        text: '❌ Cancel: ' + (r.text.length > 20 ? r.text.substring(0, 20) + '…' : r.text),
        callback_data: 'cancel_reminder:' + r.id,
      }]);
    });

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    };

    try {
      await bot.sendMessage(msg.chat.id, reply.trim(), opts);
    } catch (mdErr) {
      // Fallback to plain text if Markdown fails
      await bot.sendMessage(msg.chat.id, reply.trim().replace(/[_*`\[]/g, ''), {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    }
  });

  // ── Callback query handler: cancel reminders + confirm config changes ─────
  bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const msgId = callbackQuery.message.message_id;
    const userId = String(callbackQuery.from.id);

    // ── Confirm config change ────────────────────────────────────────────
    if (data.startsWith('confirm_config')) {
      try {
        const pending = await confirmPendingConfig(userId);
        if (!pending) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '⏰ Expired or no pending change.' });
          return;
        }

        // Clear conversation history for name/personality changes so new style takes effect
        if (pending.key === 'bot_name' || pending.key === 'bot_personality') {
          clearHistory(userId);
        }

        // Refresh cron if time setting changed
        if (pending.envKey === 'MORNING_BRIEFING_TIME' || pending.envKey === 'WEEKLY_REVIEW_TIME') {
          try {
            const { refreshSchedules } = require('../scheduler');
            if (typeof refreshSchedules === 'function') await refreshSchedules();
          } catch { /* scheduler may not be loaded */ }
        }

        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Updated!' });
        await bot.editMessageText(
          '✅ *' + pending.label + ' updated!*\n\n' + escapeMd(pending.value),
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Config confirm error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed. Try again.' });
      }
      return;
    }

    // ── Cancel config change ─────────────────────────────────────────────
    if (data.startsWith('cancel_config')) {
      removePendingConfig(userId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Cancelled.' });
      try {
        await bot.editMessageText(
          '❌ *Change cancelled.*',
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
      } catch {
        await bot.editMessageText('❌ Change cancelled.', { chat_id: chatId, message_id: msgId });
      }
      return;
    }

    // ── Revert config ────────────────────────────────────────────────────
    if (data.startsWith('revert_config:')) {
      const key = data.split(':')[1];
      try {
        const result = await tools.executeTool(userId, { name: 'revert_config', args: { key } });
        // Clear history if name/personality reverted
        if (key === 'bot_name' || key === 'bot_personality') {
          clearHistory(userId);
        }
        await bot.answerCallbackQuery(callbackQuery.id, { text: '↩️ Reverted!' });
        try {
          await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
        } catch {
          await bot.editMessageText(result, { chat_id: chatId, message_id: msgId });
        }
      } catch (err) {
        console.error('Revert config error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to revert.' });
      }
      return;
    }

    // ── Edit reminder: prompt user for changes ──────────────────────────
    if (data.startsWith('edit_reminder:')) {
      const reminderId = parseInt(data.split(':')[1], 10);
      if (isNaN(reminderId)) return;
      await bot.answerCallbackQuery(callbackQuery.id);

      // Fetch reminder text for context
      let label = 'reminder #' + reminderId;
      try {
        const reminders = await db.getUpcomingReminders(userId, 50);
        const found = reminders.find(r => r.id === reminderId);
        if (found) label = '"' + found.text + '"';
      } catch { /* ignore */ }

      setPendingEdit(userId, 'reminder', reminderId, label);

      await bot.sendMessage(chatId,
        '✏️ *Editing ' + escapeMd(label) + ' (#' + reminderId + ')*\n\n' +
        'Just tell me what to change. Contoh:\n' +
        '• "Tukar ke pukul 3 petang"\n' +
        '• "Change to 8pm tomorrow"\n' +
        '• "Repeat daily"',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ── Edit event: prompt user for changes ──────────────────────────────
    if (data.startsWith('edit_event:')) {
      const eventId = parseInt(data.split(':')[1], 10);
      if (isNaN(eventId)) return;
      await bot.answerCallbackQuery(callbackQuery.id);

      let label = 'event #' + eventId;
      setPendingEdit(userId, 'event', eventId, label);

      await bot.sendMessage(chatId,
        '✏️ *Editing ' + escapeMd(label) + ' (#' + eventId + ')*\n\n' +
        'Just tell me what to change. Contoh:\n' +
        '• "Tukar ke pukul 3 petang"\n' +
        '• "Change title to Team meeting"\n' +
        '• "Change duration to 30 min"',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ── Cancel event ─────────────────────────────────────────────────────
    if (data.startsWith('cancel_event:')) {
      const eventId = parseInt(data.split(':')[1], 10);
      if (isNaN(eventId)) return;
      try {
        await db.cancelEvent(eventId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🗑️ Event cancelled!' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Cancel event error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to cancel. Try again.' });
      }
      return;
    }

    // ── Delete note ──────────────────────────────────────────────────────
    if (data.startsWith('delete_note:')) {
      const noteId = parseInt(data.split(':')[1], 10);
      if (isNaN(noteId)) return;
      try {
        await db.deleteNote(noteId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🗑️ Note deleted!' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Delete note error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to delete. Try again.' });
      }
      return;
    }

    // ── Forget fact ──────────────────────────────────────────────────────
    if (data.startsWith('forget_fact:')) {
      const factKey = decodeURIComponent(data.split(':').slice(1).join(':'));
      if (!factKey) return;
      try {
        await db.deleteFact(userId, factKey);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🧠 Fact forgotten!' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Forget fact error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to forget. Try again.' });
      }
      return;
    }

    // ── Resolve conflict ─────────────────────────────────────────────────
    if (data.startsWith('resolve_conflict:')) {
      const parts = data.split(':');
      const factKey = decodeURIComponent(parts[1]);
      const resolution = parts[2]; // 'keep_current' or 'restore_previous'
      if (!factKey || !resolution) return;

      try {
        await memory.resolveConflict(userId, factKey, resolution);
        const label = resolution === 'restore_previous' ? '↩️ Restored previous value!' : '✅ Kept current value!';
        await bot.answerCallbackQuery(callbackQuery.id, { text: label });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Resolve conflict error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to resolve. Try again.' });
      }
      return;
    }

    // ── Task actions ─────────────────────────────────────────────────────
    if (data.startsWith('start_task:') || data.startsWith('complete_task:') || data.startsWith('cancel_task:')) {
      const [action, idStr] = data.split(':');
      const taskId = parseInt(idStr, 10);
      if (isNaN(taskId)) return;

      const toolName = action === 'start_task' ? 'start_task' : action === 'complete_task' ? 'complete_task' : 'cancel_task';
      try {
        const result = await tools.executeTool(userId, { name: toolName, args: { task_id: taskId } });
        await bot.answerCallbackQuery(callbackQuery.id, { text: action === 'start_task' ? '🚀 Started!' : action === 'complete_task' ? '🎉 Done!' : '❌ Cancelled' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
        const msg = typeof result === 'object' ? result.message : result;
        try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch { await bot.sendMessage(chatId, msg); }
      } catch (err) {
        console.error('Task action error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed. Try again.' });
      }
      return;
    }

    // ── Goal actions ─────────────────────────────────────────────────────
    if (data.startsWith('complete_goal:') || data.startsWith('abandon_goal:')) {
      const [action, idStr] = data.split(':');
      const goalId = parseInt(idStr, 10);
      if (isNaN(goalId)) return;

      const toolName = action === 'complete_goal' ? 'complete_goal' : 'abandon_goal';
      try {
        const result = await tools.executeTool(userId, { name: toolName, args: { goal_id: goalId } });
        await bot.answerCallbackQuery(callbackQuery.id, { text: action === 'complete_goal' ? '🏆 Achieved!' : '🗑️ Abandoned' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
        const msg = typeof result === 'object' ? result.message : result;
        try { await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch { await bot.sendMessage(chatId, msg); }
      } catch (err) {
        console.error('Goal action error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed. Try again.' });
      }
      return;
    }

    // ── Dismiss reminder (mark as done) ──────────────────────────────────
    if (data.startsWith('dismiss_reminder:')) {
      const reminderId = parseInt(data.split(':')[1], 10);
      if (isNaN(reminderId)) return;
      try {
        await db.markReminderSent(reminderId);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Done!' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
      } catch (err) {
        console.error('Dismiss reminder error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed. Try again.' });
      }
      return;
    }

    // ── Snooze reminder ──────────────────────────────────────────────────
    if (data.startsWith('snooze_reminder:')) {
      const reminderId = parseInt(data.split(':')[1], 10);
      if (isNaN(reminderId)) return;
      try {
        const snoozed = await db.snoozeReminder(reminderId, 10);
        if (!snoozed) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Reminder not found.' });
          return;
        }
        const newTime = fmt(snoozed.remind_at, 'h:mm A');
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🔁 Snoozed 10 min → ' + newTime });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
        await bot.sendMessage(chatId, '🔁 Reminder snoozed for 10 minutes — will remind again at *' + escapeMd(newTime) + '*.', { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Snooze reminder error:', err.message);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to snooze.' });
      }
      return;
    }

    // ── Cancel reminder (existing) ───────────────────────────────────────
    if (!data.startsWith('cancel_reminder:')) return;

    const reminderId = parseInt(data.split(':')[1], 10);
    if (isNaN(reminderId)) return;

    try {
      await db.cancelReminder(reminderId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Reminder cancelled! ✅' });

      // Edit the original message to remove the cancelled button
      const currentText = callbackQuery.message.text || callbackQuery.message.caption || '';
      const currentKeyboard = callbackQuery.message.reply_markup.inline_keyboard;

      // Remove the clicked button
      const newKeyboard = currentKeyboard
        .map(row => row.filter(btn => btn.callback_data !== data))
        .filter(row => row.length > 0);

      await bot.editMessageReplyMarkup(
        { inline_keyboard: newKeyboard },
        { chat_id: chatId, message_id: msgId }
      );
    } catch (err) {
      console.error('Cancel reminder error:', err.message);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to cancel. Try again.' });
    }
  });

  // ── /briefing command ─────────────────────────────────────────────────────
  bot.onText(/\/briefing/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const message = await buildBriefingMessage();
      await safeSendMessage(bot, msg.chat.id, message);
    } catch (err) {
      console.error('/briefing error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate briefing.');
    }
  });

  // ── /review command ──────────────────────────────────────────────────────
  bot.onText(/\/review/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const { buildWeeklyReview } = require('../scheduler');
      const message = await buildWeeklyReview();
      await safeSendMessage(bot, msg.chat.id, message);
    } catch (err) {
      console.error('/review error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate weekly review.');
    }
  });

  // ── /quote command ────────────────────────────────────────────────────────
  bot.onText(/\/quote/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const quote = await getQuote();
      await safeSendMessage(bot, msg.chat.id, quote);
    } catch (err) {
      console.error('/quote error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not fetch a quote.');
    }
  });

  // ── /help command ─────────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isOwner(msg)) return;
    const help =
      '*Jarvis Commands* 🤖\n\n' +
      '/start — Wake up Jarvis\n' +
      '/today — See today\'s schedule\n' +
      '/briefing — Morning briefing (events, reminders, weather, quote)\n' +
      '/review — Weekly review summary\n' +
      '/quote — Get a motivational quote\n' +
      '/notes — View recent notes\n' +
      '/reminders — List upcoming reminders\n' +
      '/tasks — List active tasks\n' +
      '/goals — View your goals & progress\n' +
      '/memory — See stored facts\n' +
      '/verify — Review & resolve conflicting facts\n' +
      '/reflect — Generate daily reflection & insights\n' +
      '/history — Search past conversations (/history <keyword>)\n' +
      '/status — Check API connections\n' +
      '/help — This message\n' +
      '/settings — View current bot settings\n' +
      '/setname <name> — Change bot name\n' +
      '/setpersonality <text> — Change bot personality\n' +
      '/setlocation <city> — Change weather location\n' +
      '/setbriefing <HH:MM> — Change morning briefing time\n' +
      '/setreview <HH:MM> — Change weekly review time\n\n' +
      '*Or just talk to me naturally!*\n' +
      'Examples:\n' +
      '• "Remind me to take meds at 8pm"\n' +
      '• "Remind me to drink water every day at 9am"\n' +
      '• "Add standup to calendar at 9am tomorrow"\n' +
      '• "Note: follow up with client on Friday"\n' +
      '• "Remember I wake up at 6am"\n' +
      '• "What\'s my day looking like?"\n' +
      '• "Cancel reminder #3"\n\n' +
      '🎤 *You can also send voice messages!*';
    await safeSendMessage(bot, msg.chat.id, help);
  });

  // ── /settings command ─────────────────────────────────────────────────────
  bot.onText(/\/settings/, async (msg) => {
    if (!isOwner(msg)) return;
    try {
      const settings = await db.getAllSettings(OWNER_ID);
      const botName = settings.bot_name || process.env.BOT_NAME || 'Jarvis';
      const personality = settings.bot_personality || process.env.BOT_PERSONALITY || '(not set)';
      const briefingTime = settings.morning_briefing_time || process.env.MORNING_BRIEFING_TIME || '7:00';
      const reviewTime = settings.weekly_review_time || process.env.WEEKLY_REVIEW_TIME || '20:00';
      const location = settings.weather_location || process.env.WEATHER_LOCATION || '(not set)';

      // Check for previous (revertable) values
      const hasPrev = (k) => settings['prev_' + k] && settings['prev_' + k].trim() !== '';

      let reply =
        '*⚙️ Current Settings*\n\n' +
        '🤖 *Bot Name:* ' + escapeMd(botName) + (hasPrev('bot_name') ? ' ↩️' : '') + '\n' +
        '🎭 *Personality:* ' + escapeMd(personality.length > 80 ? personality.slice(0, 80) + '…' : personality) + (hasPrev('bot_personality') ? ' ↩️' : '') + '\n' +
        '🌅 *Morning Briefing:* ' + escapeMd(briefingTime) + (hasPrev('morning_briefing_time') ? ' ↩️' : '') + '\n' +
        '📊 *Weekly Review:* ' + escapeMd(reviewTime) + ' (Sunday)' + (hasPrev('weekly_review_time') ? ' ↩️' : '') + '\n' +
        '🌤️ *Weather Location:* ' + escapeMd(location) + (hasPrev('weather_location') ? ' ↩️' : '') + '\n\n' +
        '_Use /setname, /setpersonality, /setlocation, /setbriefing, /setreview to change._\n' +
        '_↩️ = can be reverted with /revert_';

      await safeSendMessage(bot, msg.chat.id, reply);
    } catch (err) {
      console.error('/settings error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not fetch settings.');
    }
  });

  // ── /revert command ───────────────────────────────────────────────────────
  bot.onText(/\/revert/, async (msg) => {
    if (!isOwner(msg)) return;
    try {
      const settings = await db.getAllSettings(OWNER_ID);
      const revertable = [];

      const labels = {
        bot_name: 'Bot Name', bot_personality: 'Bot Personality',
        morning_briefing_time: 'Morning Briefing Time', weekly_review_time: 'Weekly Review Time',
        weather_location: 'Weather Location',
      };

      for (const [key, label] of Object.entries(labels)) {
        const prevVal = settings['prev_' + key];
        if (prevVal && prevVal.trim() !== '') {
          revertable.push({ key, label, prev: prevVal });
        }
      }

      if (revertable.length === 0) {
        return bot.sendMessage(msg.chat.id, 'No previous settings to revert to. Make a change first!');
      }

      const inlineKeyboard = revertable.map(r => ([{
        text: '↩️ ' + r.label + ' → ' + (r.prev.length > 25 ? r.prev.slice(0, 25) + '…' : r.prev),
        callback_data: 'revert_config:' + r.key,
      }]));

      await bot.sendMessage(msg.chat.id, '*↩️ Revert a setting to its previous value:*', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch (err) {
      console.error('/revert error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not check revert options.');
    }
  });

  // ── /setname command ──────────────────────────────────────────────────────
  bot.onText(/\/setname (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!value) return bot.sendMessage(msg.chat.id, 'Usage: /setname <name>');
    const currentVal = await db.getConfig(OWNER_ID, 'bot_name', 'BOT_NAME');
    setPendingConfig(OWNER_ID, 'bot_name', 'BOT_NAME', value, 'Bot Name');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Bot Name* → ' + escapeMd(value) + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /setpersonality command ───────────────────────────────────────────────
  bot.onText(/\/setpersonality (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!value) return bot.sendMessage(msg.chat.id, 'Usage: /setpersonality <text>');
    const currentVal = await db.getConfig(OWNER_ID, 'bot_personality', 'BOT_PERSONALITY');
    setPendingConfig(OWNER_ID, 'bot_personality', 'BOT_PERSONALITY', value, 'Bot Personality');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal.length > 50 ? currentVal.slice(0, 50) + '…' : currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Bot Personality* → ' + escapeMd(value.length > 80 ? value.slice(0, 80) + '…' : value) + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /setlocation command ──────────────────────────────────────────────────
  bot.onText(/\/setlocation (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!value) return bot.sendMessage(msg.chat.id, 'Usage: /setlocation <city>');
    const currentVal = await db.getConfig(OWNER_ID, 'weather_location', 'WEATHER_LOCATION');
    setPendingConfig(OWNER_ID, 'weather_location', 'WEATHER_LOCATION', value, 'Weather Location');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Weather Location* → ' + escapeMd(value) + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /setbriefing command ──────────────────────────────────────────────────
  bot.onText(/\/setbriefing (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!/^\d{1,2}:\d{2}$/.test(value)) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid format. Use 24h time, e.g. `/setbriefing 7:00`');
    }
    const currentVal = await db.getConfig(OWNER_ID, 'morning_briefing_time', 'MORNING_BRIEFING_TIME');
    setPendingConfig(OWNER_ID, 'morning_briefing_time', 'MORNING_BRIEFING_TIME', value, 'Morning Briefing Time');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Morning Briefing Time* → ' + escapeMd(value) + ' daily' + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /setreview command ────────────────────────────────────────────────────
  bot.onText(/\/setreview (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const value = match[1].trim();
    if (!/^\d{1,2}:\d{2}$/.test(value)) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid format. Use 24h time, e.g. `/setreview 20:00`');
    }
    const currentVal = await db.getConfig(OWNER_ID, 'weekly_review_time', 'WEEKLY_REVIEW_TIME');
    setPendingConfig(OWNER_ID, 'weekly_review_time', 'WEEKLY_REVIEW_TIME', value, 'Weekly Review Time');
    const currentStr = currentVal ? '\n_Current: ' + escapeMd(currentVal) + '_' : '';
    await bot.sendMessage(msg.chat.id,
      '⚙️ *Confirm Change?*\n\n*Weekly Review Time* → ' + escapeMd(value) + ' Sunday' + currentStr, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ya', callback_data: 'confirm_config' },
          { text: '❌ Batal', callback_data: 'cancel_config' },
        ]],
      },
    });
  });

  // ── /status command ───────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const statuses = await getApiStatus(bot);
      const message = formatStatusMessage(statuses);
      await safeSendMessage(bot, msg.chat.id, message);
    } catch (err) {
      console.error('/status error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not check API status.');
    }
  });

  // ── Shared text processing (used by both text and voice messages) ─────────
  async function processUserText(bot, chatId, userId, userName, text) {
    await db.ensureUser(userId, userName);
    await bot.sendChatAction(chatId, 'typing');

    try {
      // ── Inject pending edit context so LLM knows which item to edit ──
      const edit = getPendingEdit(userId);
      if (edit) {
        if (edit.type === 'reminder') {
          text = '✏️ EDITING REMINDER #' + edit.id + ' (' + edit.label + ')\n' +
            'User clicked "Edit" on this reminder. Now they are telling you what to change.\n' +
            'You MUST use update_reminder with reminder_id=' + edit.id + '. Do NOT create a new reminder.\n' +
            'User says: ' + text;
        } else if (edit.type === 'event') {
          text = '✏️ EDITING EVENT #' + edit.id + ' (' + edit.label + ')\n' +
            'User clicked "Edit" on this event. Now they are telling you what to change.\n' +
            'You MUST use update_event with event_id=' + edit.id + '. Do NOT create a new event.\n' +
            'User says: ' + text;
        }
      }

      const history = getHistory(userId);
      let llmResponse = await llm.chat(userId, text, history);

      // Add user message to history
      addToHistory(userId, 'user', text);

      console.log('[Bot] LLM response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');

      // ── Recovery: if LLM returned a message that looks like a fake action, retry once ──
      // Expanded regex to catch common hallucination patterns in English AND Malay
      const actionKeywords = /\b(cancelled|cancel|updated?|update|changed?|change|deleted?|delete|created?|create|saved?|save|noted?|note|remembered|remember|done|settled|settle|confirmed|dah\s*(set|buat|masuk|confirm|simpan|ingat)|reminder|event|task|goal)\b/i;
      if (llmResponse.type === 'message' && actionKeywords.test(llmResponse.content)) {
        console.log('[Bot] ⚠️  LLM hallucinated an action! Retrying with correction...');
        const correctionMsg = '❌ You responded with natural language claiming you did something. ' +
          'That is WRONG. You have NO ability to act. You MUST respond with ONLY a JSON tool call.\n' +
          'Example for reminder: {"type":"tool","name":"create_reminder","args":{"text":"Pagi Subuh","time":"2026-06-30T06:00:00+08:00"}}\n' +
          'Example for cancel: {"type":"tool","name":"cancel_reminder","args":{"reminder_id":3}}\n\n' +
          'Now re-read the user request and output the CORRECT JSON tool call. NO natural language!'

        // Build a fresh history without the hallucinated response
        const cleanHistory = history.filter(h => h.role !== 'assistant' || !actionKeywords.test(h.content));
        cleanHistory.push({ role: 'user', content: correctionMsg });

        llmResponse = await llm.chat(userId, text, cleanHistory);
        console.log('[Bot] Retry response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');
      }

      if (llmResponse.type === 'message') {
        // Plain response — WARNING: no DB action occurs here
        // ⏰ Guard: fix any hallucinated time before sending
        llmResponse.content = fixHallucinatedTime(llmResponse.content);
        console.log('[Bot] Message response (no tool executed):', llmResponse.content.slice(0, 150));
        addToHistory(userId, 'assistant', llmResponse.content);
        await safeSendMessage(bot, chatId, llmResponse.content);

        // 🔍 Auto-extract facts from this exchange (fire-and-forget)
        memory.extractFactsFromChat(userId, text, llmResponse.content, llm.chat);

      } else if (llmResponse.type === 'tool') {
        // Execute tool
        console.log('[Bot] Executing tool:', llmResponse.name, JSON.stringify(llmResponse.args).slice(0, 200));
        let result;
        try {
          result = await tools.executeTool(userId, {
            name: llmResponse.name,
            args: llmResponse.args,
          });
          console.log('[Bot] Tool result:', typeof result === 'object' ? (result.type || 'object') : result.slice(0, 150));
        } catch (toolErr) {
          console.error('[Bot] Tool execution error:', toolErr.message);
          result = 'I tried to do that but ran into a problem. Please try again.';
        }

        // ── Confirmation flow: if tool returned {type:'confirm', message} ──
        if (result && typeof result === 'object' && result.type === 'confirm') {
          addToHistory(userId, 'assistant', result.message);
          try {
            await bot.sendMessage(chatId, result.message, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Ya', callback_data: 'confirm_config' },
                  { text: '❌ Batal', callback_data: 'cancel_config' },
                ]],
              },
            });
          } catch {
            await bot.sendMessage(chatId, result.message, {
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Ya', callback_data: 'confirm_config' },
                  { text: '❌ Batal', callback_data: 'cancel_config' },
                ]],
              },
            });
          }
          // 🔍 Auto-extract facts from this exchange (fire-and-forget)
          memory.extractFactsFromChat(userId, text, result.message, llm.chat);
          return; // Done — wait for user to click button or type "ya"
        }

        // ── Smart Follow-up: after add_note, check if it implies a reminder ──
        let followupResult = null;
        if (llmResponse.name === 'add_note' && llmResponse.args.content) {
          const noteContent = llmResponse.args.content;
          const followupPrompt =
            '📝 The user just saved this note: "' + noteContent + '"\n\n' +
            'YOUR JOB: Determine if this note implies a follow-up task that should become a reminder.\n\n' +
            'Examples that SHOULD create a reminder:\n' +
            '• "follow up with Ali on Friday" → reminder: "Follow up with Ali" on Friday\n' +
            '• "call client tomorrow 3pm" → reminder: "Call client" tomorrow at 3pm\n' +
            '• "send report by Monday" → reminder: "Send report" on Monday\n\n' +
            'Examples that should NOT:\n' +
            '• "React Native looks promising" → no reminder\n' +
            '• "idea for blog post" → no reminder (just an idea)\n' +
            '• "buy groceries" → no specific time, so no reminder\n\n' +
            'If a reminder IS needed, output: {"type":"tool","name":"create_reminder","args":{"text":"...","time":"ISO-8601"}}\n' +
            'If NOT needed, output: {"type":"message","content":"SKIP"}';

          try {
            const followupHistory = [{ role: 'user', content: followupPrompt }];
            const followupResponse = await llm.chat(userId, noteContent, followupHistory);
            console.log('[Bot] Follow-up check result:', followupResponse.type, followupResponse.name || '');

            if (followupResponse.type === 'tool' && followupResponse.name === 'create_reminder') {
              followupResult = await tools.executeTool(userId, {
                name: 'create_reminder',
                args: followupResponse.args,
              });
              console.log('[Bot] Smart follow-up reminder created');
            }
          } catch (fuErr) {
            console.warn('[Bot] Smart follow-up check failed (non-fatal):', fuErr.message);
          }
        }

        // ── Web Search: re-summarize results in the user's language via LLM ──
        if (llmResponse.name === 'web_search') {
          try {
            const summarizePrompt =
              '🌐 You just performed a web search for the user. Below are the raw search results.\n\n' +
              'YOUR JOB: Summarize these results in a helpful, concise reply.\n\n' +
              '🚨 CRITICAL LANGUAGE RULE (NON-NEGOTIABLE):\n' +
              '• User wrote in English → reply in English\n' +
              '• User wrote in Bahasa Melayu → reply in Bahasa Melayu\n' +
              '• User wrote rojak (campur BM+English, e.g. "apa news terkini about AI?") → reply rojak juga\n' +
              '• Match the user\'s exact language style and tone. JANGAN tukar bahasa!\n\n' +
              'User\'s original query: "' + text + '"\n\n' +
              '─────────────── RAW SEARCH RESULTS ───────────────\n' +
              (typeof result === 'object' && result.message ? result.message : result) + '\n' +
              '──────────────────────────────────────────────────\n\n' +
              'Now write a natural, friendly reply summarizing these results. ' +
              'Respond with: {"type":"message","content":"your summary here"}';

            const summarizeHistory = [{ role: 'user', content: summarizePrompt }];
            const summaryResponse = await llm.chat(userId, text, summarizeHistory);
            console.log('[Bot] Web search re-summary result:', summaryResponse.type, summaryResponse.content ? summaryResponse.content.slice(0, 150) : '');

            if (summaryResponse.type === 'message' && summaryResponse.content) {
              result = fixHallucinatedTime(summaryResponse.content);
            }
          } catch (summaryErr) {
            console.warn('[Bot] Web search re-summary failed (using raw results):', summaryErr.message);
          }
        }

        // ── Send result with inline buttons for actionable tool results ──
        const isStructured = result && typeof result === 'object' && result.type === 'result';
        const resultText = isStructured ? result.message : result;

        // ── Clear pending edit after successful update ──
        if (isStructured && (result.tool === 'update_reminder' || result.tool === 'update_event')) {
          clearPendingEdit(userId);
        }
        // If user said something unrelated while editing, clear pending edit
        if (edit && !isStructured) {
          clearPendingEdit(userId);
        }

        // Build final text (with possible follow-up)
        const followupText = followupResult
          ? (typeof followupResult === 'object' && followupResult.message ? followupResult.message : followupResult)
          : null;
        const finalResult = followupText ? resultText + '\n\n' + followupText : resultText;

        addToHistory(userId, 'assistant', finalResult);

        // Determine inline keyboard based on tool type
        let inlineKeyboard = null;
        if (isStructured) {
          switch (result.tool) {
            case 'create_reminder':
            case 'update_reminder':
              inlineKeyboard = [[
                { text: '✏️ Edit', callback_data: 'edit_reminder:' + result.id },
                { text: '❌ Cancel', callback_data: 'cancel_reminder:' + result.id },
              ]];
              break;
            case 'create_event':
            case 'update_event':
              inlineKeyboard = [[
                { text: '✏️ Edit', callback_data: 'edit_event:' + result.id },
                { text: '❌ Cancel', callback_data: 'cancel_event:' + result.id },
              ]];
              break;
            case 'add_note':
              inlineKeyboard = [[
                { text: '❌ Delete', callback_data: 'delete_note:' + result.id },
              ]];
              break;
            case 'set_fact':
              inlineKeyboard = [[
                { text: '❌ Forget', callback_data: 'forget_fact:' + encodeURIComponent(result.meta.key) },
              ]];
              break;
            case 'create_task':
              inlineKeyboard = [[
                { text: '🚀 Start', callback_data: 'start_task:' + result.id },
                { text: '✅ Done', callback_data: 'complete_task:' + result.id },
                { text: '❌ Cancel', callback_data: 'cancel_task:' + result.id },
              ]];
              break;
            case 'create_goal':
              inlineKeyboard = [[
                { text: '🏆 Complete', callback_data: 'complete_goal:' + result.id },
                { text: '🗑️ Abandon', callback_data: 'abandon_goal:' + result.id },
              ]];
              break;
          }
        }

        if (inlineKeyboard) {
          try {
            await bot.sendMessage(chatId, finalResult, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: inlineKeyboard },
            });
          } catch {
            await bot.sendMessage(chatId, finalResult, {
              reply_markup: { inline_keyboard: inlineKeyboard },
            });
          }
        } else {
          await safeSendMessage(bot, chatId, finalResult);
        }

        // 🔍 Auto-extract facts from this exchange (fire-and-forget)
        memory.extractFactsFromChat(userId, text, finalResult, llm.chat);

      } else {
        console.log('[Bot] Unknown LLM response type:', llmResponse.type);
        await bot.sendMessage(chatId, 'Something went wrong. Try again?');
      }

    } catch (err) {
      console.error('Message handler error:', err.message);
      let errorMsg = 'Something went wrong. ';
      if (err.response && err.response.status === 401) {
        errorMsg += 'Check your API key.';
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorMsg += 'Can\'t reach the API. Check your internet connection.';
      } else {
        errorMsg += 'Please try again.';
      }
      await safeSendMessage(bot, chatId, errorMsg);
    }
  }

  // ── Main text message handler ────────────────────────────────────────────
  bot.on('message', async (msg) => {
    // Skip commands (handled above) and non-owner messages
    if (!isOwner(msg)) return;
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;

    const userId = OWNER_ID;
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Owner';
    const text = msg.text.trim().toLowerCase();

    // ── Check for pending config confirmation (text reply) ─────────────────
    const confirmWords = /^(ya|yes|y|ok|okay|confirm|setuju|on|yup|👍)$/i;
    const cancelWords = /^(batal|no|n|tidak|cancel|off|nope|👎)$/i;

    const pending = getPendingConfig(userId);
    if (pending && (confirmWords.test(text) || cancelWords.test(text))) {
      if (confirmWords.test(text)) {
        try {
          const confirmed = await confirmPendingConfig(userId);
          if (!confirmed) {
            await safeSendMessage(bot, chatId, '⏰ No pending change found (may have expired).');
            return;
          }
          // Clear history for name/personality so new style takes effect immediately
          if (confirmed.key === 'bot_name' || confirmed.key === 'bot_personality') {
            clearHistory(userId);
          }
          // Refresh cron if time setting changed
          if (confirmed.envKey === 'MORNING_BRIEFING_TIME' || confirmed.envKey === 'WEEKLY_REVIEW_TIME') {
            try {
              if (typeof refreshSchedules === 'function') await refreshSchedules();
            } catch { /* ignore */ }
          }
          await safeSendMessage(bot, chatId, '✅ *' + confirmed.label + ' updated!*\n\n' + escapeMd(confirmed.value));
        } catch (err) {
          console.error('Text confirm error:', err.message);
          await safeSendMessage(bot, chatId, '❌ Failed to update setting.');
        }
      } else {
        removePendingConfig(userId);
        await safeSendMessage(bot, chatId, '❌ Change cancelled.');
      }
      return;
    }

    await processUserText(bot, chatId, userId, userName, msg.text);
  });

  // ── Voice message handler ────────────────────────────────────────────────
  bot.on('voice', async (msg) => {
    if (!isOwner(msg)) return;

    const userId = OWNER_ID;
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Owner';

    console.log('[Bot] 🎤 Voice message received (duration:', msg.voice.duration + 's)');

    // Check if OpenAI API key is configured
    if (!process.env.OPENAI_API_KEY) {
      await safeSendMessage(bot, chatId,
        '🎤 Voice messages are not set up yet.\n\n' +
        'Add your *OPENAI_API_KEY* to the `.env` file to enable voice transcription with Whisper.'
      );
      return;
    }

    await bot.sendChatAction(chatId, 'typing');

    let tmpPath;
    try {
      // Download the voice file from Telegram
      tmpPath = await downloadVoiceFile(bot, msg.voice.file_id);

      // Transcribe with Whisper
      const transcribedText = await transcribe(tmpPath, 'telegram_bot');

      if (!transcribedText) {
        await bot.sendMessage(chatId, '🎤 I received your voice message but couldn\'t make out any words. Try again?');
        return;
      }

      // Echo the transcription so the user can see what was understood
      await bot.sendMessage(chatId, '🎤 _"' + escapeMd(transcribedText) + '"_', { parse_mode: 'Markdown' });

      // Process the transcribed text through the normal pipeline
      await processUserText(bot, chatId, userId, userName, transcribedText);

    } catch (err) {
      console.error('[Bot] Voice processing error:', err.message);
      if (err.response && err.response.status === 401) {
        await safeSendMessage(bot, chatId, '🔑 Invalid OpenAI API key. Check your OPENAI_API_KEY in .env');
      } else if (err.message.includes('OPENAI_API_KEY')) {
        await safeSendMessage(bot, chatId, '🎤 Voice transcription is not configured. Add OPENAI_API_KEY to your .env file.');
      } else {
        await safeSendMessage(bot, chatId, '🎤 Sorry, I couldn\'t process that voice message. Please try again or type it out.');
      }
    }
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
  });

  return bot;
}

module.exports = { createBot };
