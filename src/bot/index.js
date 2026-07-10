// src/bot/index.js
// Telegram bot - handles all incoming messages
require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
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
const { formatFeaturesMarkdown } = require('../api/features');
const memory = require('../memory');
const relationships = require('../memory/relationships');
const domains = require('../memory/domains');
const patterns = require('../patterns');
const executive = require('../executive');
const stateMachine = require('../executive/state-machine');
const lifecycle = require('../executive/lifecycle');
const cascade = require('../executive/cascade');
const trace = require('../utils/trace');
const { invalidateConfigCache } = require('../llm/shared');
const { eventBus, EVENTS } = require('../events');
const { pluginRegistry } = require('../plugins');
const { agentRegistry } = require('../agents');
const { fixHallucinatedGreeting, fixHallucinatedTime } = require('./anti-hallucination');
const historyModule = require('./history');
const queueSystem = require('../queue');
const vision = require('../llm/vision');
const tts = require('../llm/tts');
const streaks = require('../features/streaks');

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);

// Simple in-memory conversation history per user (last 10 turns)
// NOTE: Now managed by ./history.js — these are kept for backward compat
// with existing code that accesses them directly.
const conversationHistory = {}; // shadowed by history.js internals
const pendingEdits = {};        // shadowed by history.js internals
const SUMMARIZE_THRESHOLD = historyModule.SUMMARIZE_THRESHOLD;
const KEEP_RECENT = historyModule.KEEP_RECENT;
const recentUserMessages = new Map();

// ── Delegated functions (thin wrappers to ./history.js) ──────────────────
const loadHistoryFromDB = historyModule.loadHistoryFromDB;
const getHistory = historyModule.getHistory;
const addToHistory = historyModule.addToHistory;
const clearHistory = historyModule.clearHistory;
const getEffectiveHistory = historyModule.getEffectiveHistory;
const generateSmartSummary = historyModule.generateSmartSummary;
const buildTopicSummary = (msgs) => historyModule.getEffectiveHistory; // deprecated, use getEffectiveHistory
const setPendingEdit = historyModule.setPendingEdit;
const getPendingEdit = historyModule.getPendingEdit;
const clearPendingEdit = historyModule.clearPendingEdit;
const isDuplicateUserMessage = historyModule.isDuplicateUserMessage;
const cacheUserMessageResponse = historyModule.cacheUserMessageResponse;

// ── Working Memory Helpers ─────────────────────────────────────────────────
// Extract the main topic from a user message and bot response for memory continuity

/**
 * Extract the primary topic from an exchange to track in working memory.
 * Uses keyword heuristics to identify what the conversation is about.
 */
function extractMainTopic(userText, botResponse) {
  if (!userText) return null;
  const combined = (userText + ' ' + (botResponse || '')).toLowerCase();

  const topicPatterns = [
    // Schedule & time
    { pattern: /(?:alarm|jam|pukul|waktu|masa|time|clock|jadual|schedule)/i, topic: 'schedule/time' },
    { pattern: /(?:remind|ingatkan|reminder)/i, topic: 'reminders' },
    { pattern: /(?:event|acara|meeting|mesyuarat|appointment|temujanji)/i, topic: 'events/meetings' },

    // Productivity
    { pattern: /(?:task|tugas|todo|to-do|kerja|work)/i, topic: 'tasks/work' },
    { pattern: /(?:goal|matlamat|target|objective)/i, topic: 'goals' },
    { pattern: /(?:plan|rancang|planning|strategy|strategi)/i, topic: 'planning' },
    { pattern: /(?:note|nota|catat|simpan|save)/i, topic: 'notes' },

    // Health & routine
    { pattern: /(?:tidur|sleep|bangun|wake|alarm|subuh|pray|solat|doa|azan)/i, topic: 'morning-routine' },
    { pattern: /(?:gym|exercise|senaman|workout|run|lari|jogging|diet|makanan|healthy|sihat)/i, topic: 'health/fitness' },
    { pattern: /(?:makan|eat|food|restaurant|kedai|cafe|lunch|dinner|breakfast)/i, topic: 'food/dining' },

    // Learning
    { pattern: /(?:learn|belajar|study|course|kursus|book|buku|read|baca|tutorial|code|coding|program|react|python|javascript)/i, topic: 'learning/coding' },

    // Personal
    { pattern: /(?:family|keluarga|wife|isteri|husband|suami|anak|child|rumah|house)/i, topic: 'family/home' },
    { pattern: /(?:friend|kawan|meet|jumpa|hangout|social)/i, topic: 'social' },
    { pattern: /(?:money|duit|ringgit|rm|bank|finance|kewangan|investment|labur)/i, topic: 'finance' },

    // Travel
    { pattern: /(?:travel|jalan|cuti|holiday|vacation|trip|flight|hotel|tiket)/i, topic: 'travel' },

    // Tech
    { pattern: /(?:phone|telefon|computer|laptop|app|software|website|tech|gadget|ai|bot)/i, topic: 'technology' },

    // Weather
    { pattern: /(?:weather|cuaca|hujan|rain|panas|hot|cold|sejuk)/i, topic: 'weather' },
  ];

  for (const { pattern, topic } of topicPatterns) {
    if (pattern.test(combined)) return topic;
  }

  // Fallback: use first meaningful word from user text
  const words = userText.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  return words.length > 0 ? words[0].toLowerCase() : null;
}

/**
 * Build a one-line summary of the last exchange for context continuity.
 */
function buildExchangeSummary(userText, botResponse) {
  const userShort = userText.slice(0, 60).replace(/\n/g, ' ');
  const respShort = (botResponse || '').slice(0, 40).replace(/\n/g, ' ');

  if (!botResponse) return 'User: "' + userShort + '"';

  // If bot response is a tool confirmation, summarize the action
  if (/(?:set|created?|saved?|added?|cancelled?|updated?|deleted?)/i.test(respShort)) {
    const action = respShort.match(/(?:set|created?|saved?|added?|cancelled?|updated?|deleted?)/i)[0];
    return 'Bot ' + action + ' — user asked: "' + userShort + '"';
  }

  return 'User: "' + userShort + '" → Bot: "' + respShort + '"';
}

/**
 * Detect if the conversation has a clear directional flow.
 */
function detectConversationFlow(userText, botResponse) {
  const combined = (userText + ' ' + (botResponse || '')).toLowerCase();

  const flows = [
    { pattern: /(?:plan|rancang|atur|jadual|schedule|trip|jalan|cuti)/i, flow: 'planning_trip' },
    { pattern: /(?:debug|error|bug|fix|baiki|troubleshoot|issue|problem)/i, flow: 'debugging' },
    { pattern: /(?:learn|belajar|study|tutorial|course|how.?to)/i, flow: 'learning_session' },
    { pattern: /(?:project|projek|build|bina|develop|coding?|program)/i, flow: 'project_work' },
    { pattern: /(?:meeting|mesyuarat|discuss|bincang|present|bentang)/i, flow: 'meeting_prep' },
    { pattern: /(?:health|sihat|gym|exercise|workout|diet|fit)/i, flow: 'health_journey' },
    { pattern: /(?:morning|pagi|bangun|wake|subuh|solat|routine|rutin)/i, flow: 'morning_routine' },
    { pattern: /(?:shopping|beli|buy|order|belanja|market)/i, flow: 'shopping' },
  ];

  for (const { pattern, flow } of flows) {
    if (pattern.test(combined)) return flow;
  }

  return null;
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
        'Type /help to see all commands.\n\n' +
        'I\'m ready when you are.';

      await safeSendMessage(bot, msg.chat.id, welcome);
    } catch (err) {
      console.error('/start error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Error: ' + err.message);
    }
  });

  // ── /help command — show all available commands ──────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isOwner(msg)) return;

    const helpText =
      '*🤖 ' + botName + ' — All Commands*\n\n' +
      '💬 *Natural Language*\n' +
      'Talk naturally — reminders, calendar, notes, tasks, goals, search.\n\n' +
      '📋 *Shortcuts*\n' +
      '`/today` — Today\'s events + reminders + tasks\n' +
      '`/briefing` — Morning briefing\n' +
      '`/reminders` — All upcoming reminders\n' +
      '`/tasks` — Active tasks\n' +
      '`/goals` — Active goals\n' +
      '`/notes` — Recent notes\n' +
      '`/plan` — Active plans\n' +
      '`/memory` — Stored facts\n' +
      '`/people` — Remembered people\n' +
      '`/history` — Search past chats\n' +
      '`/verify` — Resolve conflicting facts\n' +
      '`/reflect` — Daily reflection\n' +
      '`/recap` — Conversation recap\n' +
      '`/patterns` — Detected behavior patterns\n' +
      '`/domains` — Memory by domain\n' +
      '`/streak` — Daily habit streaks 🔥\n\n' +
      '🔧 *Tools*\n' +
      '`/status` — API health check\n' +
      '`/state` — Full bot state report\n' +
      '`/queue` — Queue system stats\n' +
      '`/evaluate` — Self-evaluation stats\n' +
      '`/proactive` — Trigger proactive suggestion\n' +
      '`/lifecycle` — Conversation phase\n' +
      '`/why` — Trace last decision\n' +
      '`/trace` — Execution traces\n' +
      '`/insights` — Usage statistics\n' +
      '`/mood` — Track & view mood\n' +
      '`/weekly` — Weekly summary\n\n' +
      '🎤 *Media*\n' +
      '`/speak <text>` — Text-to-speech voice note\n' +
      'Send photo — AI image analysis\n' +
      'Send voice — Voice transcription\n\n' +
      '⚙️ *Settings*\n' +
      '`/settings` — View settings\n' +
      '`/setname <name>` — Bot name\n' +
      '`/setpersonality <text>` — Bot tone\n' +
      '`/setlocation <city>` — Weather location\n' +
      '`/setbriefing <HH:MM>` — Briefing time\n' +
      '`/setreview <HH:MM>` — Weekly review time\n' +
      '`/revert` — Undo setting change';

    try {
      await bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(msg.chat.id, helpText);
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

  // ── /streak command — view daily streaks ─────────────────────────────────
  bot.onText(/\/streak/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const message = await streaks.buildStreakMessage(OWNER_ID);
      try {
        await bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(msg.chat.id, message);
      }
    } catch (err) {
      console.error('/streak error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not load streak data.');
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

  // ── /people command — view all remembered people ─────────────────────────
  bot.onText(/\/people/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const people = await db.getRelationships(OWNER_ID, 20);
    const formatted = relationships.formatPeopleMessage(people, 'People You Know');

    try {
      await bot.sendMessage(msg.chat.id, formatted, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(msg.chat.id, formatted);
    }
  });

  // ── /person command — search for a specific person ───────────────────────
  bot.onText(/\/person(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const query = (match[1] || '').trim();
    if (!query) {
      return bot.sendMessage(msg.chat.id,
        'Usage: /person <name>\n\nExample: /person Sarah');
    }

    const results = await relationships.searchPeople(OWNER_ID, query, 5);
    if (results.length === 0) {
      return bot.sendMessage(msg.chat.id, '👤 *No match found* for "' + escapeMd(query) + '".\n\nTip: When you mention people in conversation, I automatically remember them.');
    }

    const formatted = relationships.formatPeopleMessage(results, 'Search: ' + query);

    try {
      await bot.sendMessage(msg.chat.id, formatted, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(msg.chat.id, formatted);
    }
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

      const reflection = await memory.generateDailyReflection(OWNER_ID, llm.chatMimo);
      if (reflection) {
        await safeSendMessage(bot, msg.chat.id, '*🧘 Today\'s Reflection*\n\n' + reflection);

        // 🔥 Track reflection streak
        streaks.recordActivity(OWNER_ID, 'reflection').catch(() => { });
      } else {
        await bot.sendMessage(msg.chat.id, '📭 Not enough activity today to reflect on. Talk to me more!');
      }
    } catch (err) {
      console.error('/reflect error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate reflection.');
    }
  });

  // ── /patterns command — view detected behavioral patterns ───────────────
  bot.onText(/\/patterns(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');

    try {
      const filterType = (match[1] || '').trim().toLowerCase();
      const validTypes = ['usage', 'topic', 'behavior', 'trend', 'correlation'];

      const options = {};
      if (validTypes.includes(filterType)) {
        options.type = filterType;
      }

      const detectedPatterns = await patterns.getPatterns(OWNER_ID, {
        ...options,
        minConfidence: 0.4,
        limit: 20,
      });

      if (detectedPatterns.length === 0) {
        const typeMsg = filterType ? ' for type "' + filterType + '"' : '';
        return bot.sendMessage(msg.chat.id,
          '🔍 *No patterns detected yet' + typeMsg + '.*\n\n' +
          'Keep using me and I\'ll start noticing patterns in your behavior and conversations!\n\n' +
          '_Patterns are analyzed daily at 11 PM. Use /patterns usage|topic|behavior|trend|correlation to filter._');
      }

      const formatted = patterns.formatPatternsMessage(detectedPatterns);

      try {
        await bot.sendMessage(msg.chat.id, formatted, { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(msg.chat.id, formatted);
      }
    } catch (err) {
      console.error('/patterns error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve patterns.');
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

  // ═══════════════════════════════════════════════════════════════════
  // ── FASA 1-5: New Intelligent Commands ─────────────────────────────
  // ═══════════════════════════════════════════════════════════════════

  // ── /plan command — view active plans (Fasa 4) ──────────────────────────
  bot.onText(/\/plan(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    const subCommand = (match[1] || '').trim().toLowerCase();
    const planner = require('../executive/planner');

    if (subCommand === 'create' || subCommand === 'new') {
      return bot.sendMessage(msg.chat.id,
        '📋 *Create a Plan*\n\n' +
        'Just tell me naturally what you want to achieve, for example:\n' +
        '• "Plan: Learn React Native in 2 weeks"\n' +
        '• "Help me plan my project deployment"\n' +
        '• "Buat plan untuk belajar Python"\n\n' +
        'I\'ll break it down into steps for you!');
    }

    const activePlans = planner.getPlans(OWNER_ID).filter(p => p.status === 'active');
    if (activePlans.length === 0) {
      return bot.sendMessage(msg.chat.id,
        '📋 *No active plans.*\n\n' +
        'Create one by saying something like:\n' +
        '• "Plan: Learn X in Y weeks"\n' +
        '• "Help me break down [task] into steps"');
    }

    let reply = '*📋 Active Plans*\n\n';
    for (const plan of activePlans) {
      reply += '🎯 *' + escapeMd(plan.goal) + '*\n';
      reply += '  Progress: ' + plan.progress + '% | Steps: ' + plan.steps.length + '\n';
      const nextStep = planner.getNextStep(OWNER_ID, plan.planId);
      if (nextStep) {
        reply += '  ➡️ Next: ' + escapeMd(nextStep.description) + '\n';
      }
      reply += '\n';
    }

    await safeSendMessage(bot, msg.chat.id, reply.trim());
  });

  // ── /domains command — view memory domains (Fasa 3) ────────────────────
  bot.onText(/\/domains/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const domains = require('../memory/domains');
      const stats = await domains.getDomainStats(OWNER_ID);

      if (stats.every(s => s.count === 0)) {
        return bot.sendMessage(msg.chat.id,
          '🧠 *No memory domains yet.*\n\n' +
          'As we talk, I\'ll organize what I learn about you into domains like Personal, Work, Health, etc.');
      }

      let reply = '*🧠 Memory Domains*\n\n';
      for (const s of stats) {
        if (s.count === 0) continue;
        const bar = '█'.repeat(Math.min(s.count, 20));
        reply += s.icon + ' *' + s.name + ':* ' + s.count + ' facts\n';
        reply += '  ' + bar + '\n\n';
      }

      try {
        await bot.sendMessage(msg.chat.id, reply.trim(), { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(msg.chat.id, reply.trim());
      }
    } catch (err) {
      console.error('/domains error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve domains.');
    }
  });

  // ── /evaluate command — view self-evaluation stats (Fasa 5) ────────────
  bot.onText(/\/evaluate/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const evaluator = require('../executive/evaluator');
      const summary = evaluator.getLearningSummary(OWNER_ID);

      if (!summary) {
        return bot.sendMessage(msg.chat.id,
          '📊 *No evaluation data yet.*\n\nInteract with me more and I\'ll start tracking my performance!');
      }

      const wm = executive.worldModel.get(OWNER_ID);
      let reply = '*📊 Self-Evaluation Report*\n\n' + summary + '\n\n';

      if (wm) {
        reply += '*Current State:*\n';
        reply += '• Status: ' + (wm.status || 'unknown') + '\n';
        reply += '• Domain: ' + (wm.activeDomain || 'general') + '\n';
        reply += '• Mood: ' + (wm.currentMood || 'neutral') + '\n';
        reply += '• Messages: ' + wm.messageCount + '\n';
      }

      await safeSendMessage(bot, msg.chat.id, reply.trim());
    } catch (err) {
      console.error('/evaluate error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate evaluation.');
    }
  });

  // ── /proactive command — trigger proactive suggestion (Fasa 5) ─────────
  bot.onText(/\/proactive/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const proactive = require('../executive/proactive');
      const result = await proactive.getBestProactiveMessage(OWNER_ID, bot);

      if (result) {
        await safeSendMessage(bot, msg.chat.id, result.message);
      } else {
        await bot.sendMessage(msg.chat.id,
          '💤 *Nothing to suggest right now.*\n\n' +
          'I\'ll proactively check in when:\n' +
          '• It\'s morning/evening\n' +
          '• You have stalled plans\n' +
          '• Your mood seems off\n' +
          '• You haven\'t chatted in a while');
      }
    } catch (err) {
      console.error('/proactive error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not generate suggestion.');
    }
  });

  // ── /state command — view full bot state (all Fasa) ────────────────────
  bot.onText(/\/state/, async (msg) => {
    if (!isOwner(msg)) return;
    await db.ensureUser(OWNER_ID, msg.from.first_name || 'Owner');

    try {
      const wm = executive.worldModel.get(OWNER_ID);
      const wrkMem = executive.workingMemory.get(OWNER_ID);
      const activePlan = require('../executive/planner').getActivePlan(OWNER_ID);
      const domains = require('../memory/domains');
      const stats = await domains.getDomainStats(OWNER_ID);
      const evaluator = require('../executive/evaluator');
      const evalStats = evaluator.getStats(OWNER_ID);

      let reply = '*🤖 JARVIS STATE REPORT*\n\n';

      reply += '*🌍 World Model:*\n';
      reply += '• Status: ' + (wm.status || 'unknown') + '\n';
      reply += '• Domain: ' + (wm.activeDomain || 'general') + '\n';
      reply += '• Mood: ' + (wm.currentMood || 'neutral') + '\n';
      reply += '• Project: ' + (wm.currentProject || 'none') + '\n';
      reply += '• Messages: ' + wm.messageCount + '\n\n';

      reply += '*🧠 Working Memory:*\n';
      reply += '• Goal: ' + (wrkMem.currentGoal || 'none') + '\n';
      reply += '• Problem: ' + (wrkMem.currentProblem || 'none') + '\n';
      reply += '• Steps: ' + (wrkMem.nextSteps.length > 0 ? wrkMem.nextSteps.join(', ') : 'none') + '\n\n';

      if (activePlan) {
        reply += '*📋 Active Plan:*\n';
        reply += '• Goal: ' + activePlan.goal + '\n';
        reply += '• Progress: ' + activePlan.progress + '%\n';
        reply += '• Steps: ' + activePlan.steps.filter(s => s.status === 'completed').length + '/' + activePlan.steps.length + ' done\n\n';
      }

      reply += '*📊 Domains:*\n';
      stats.filter(s => s.count > 0).forEach(s => {
        reply += '• ' + s.icon + ' ' + s.name + ': ' + s.count + '\n';
      });
      reply += '\n';

      reply += '*📈 Eval Stats:*\n';
      reply += '• Total interactions: ' + evalStats.totalInteractions + '\n';
      reply += '• Avg quality: ' + evalStats.avgQuality + '%\n';
      reply += '• Fast/Med/Deep: ' + evalStats.byTier.fast + '/' + evalStats.byTier.medium + '/' + evalStats.byTier.deep + '\n\n';

      // 🔥 Streak summary in state
      try {
        const streakLine = await streaks.buildStreakSummary(OWNER_ID);
        if (streakLine) reply += streakLine + '\n\n';
      } catch { /* ignore */ }

      try {
        await bot.sendMessage(msg.chat.id, reply.trim(), { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(msg.chat.id, reply.trim());
      }
    } catch (err) {
      console.error('/state error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve state. ' + err.message);
    }
  });

  // ── /speak command — text-to-speech voice reply ──────────────────────────
  bot.onText(/\/speak(?:\s+(.+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;

    const textToSpeak = (match[1] || '').trim();
    if (!textToSpeak) {
      return bot.sendMessage(chatId,
        '🎤 *Text-to-Speech*\n\n' +
        'Guna: `/speak <teks>`\n\n' +
        'Contoh:\n' +
        '• `/speak Selamat pagi boss`\n' +
        '• `/speak Hello, your meeting is at 3pm`\n\n' +
        '_Powered by ILMU TTS v2_',
        { parse_mode: 'Markdown' });
    }

    if (!tts.isAvailable()) {
      return bot.sendMessage(chatId,
        '🔇 TTS is powered by ILMU TTS v2.\nSet *ILMU_API_KEY* in your `.env` file.',
        { parse_mode: 'Markdown' });
    }

    await bot.sendChatAction(chatId, 'record_voice');

    try {
      const audioPath = await tts.speakToFile({ text: textToSpeak });

      if (audioPath) {
        await bot.sendVoice(chatId, audioPath, {}, {
          caption: '🎤 ' + (textToSpeak.length > 80 ? textToSpeak.slice(0, 80) + '…' : textToSpeak),
        });

        // Clean up temp file
        try { require('fs').unlinkSync(audioPath); } catch (_) { }
      } else {
        await bot.sendMessage(chatId, '🔇 Sorry, couldn\'t generate speech. Try a shorter text.');
      }
    } catch (err) {
      console.error('/speak error:', err.message);
      await bot.sendMessage(chatId, '🔇 TTS failed. The text may be too long (max 10,000 chars).');
    }
  });

  // ── /queue command — show job queue stats ────────────────────────────────
  bot.onText(/\/queue/, async (msg) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;

    try {
      const summary = queueSystem.getSummary();
      await safeSendMessage(bot, chatId, summary);
    } catch (err) {
      console.error('/queue error:', err.message);
      await bot.sendMessage(chatId, '❌ Error: ' + err.message);
    }
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
          invalidateConfigCache(userId);
        }

        // Refresh cron if time setting changed
        if (pending.envKey === 'MORNING_BRIEFING_TIME' || pending.envKey === 'REFLECTION_TIME' || pending.envKey === 'WEEKLY_REVIEW_TIME') {
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

    // ── 🔧 View list buttons ──────────────────────────────────────────────
    // list_reminders, get_today, list_notes, list_tasks, list_goals
    if (data === 'list_reminders' || data === 'get_today' ||
      data === 'list_notes' || data === 'list_tasks' || data === 'list_goals') {

      const toolMap = {
        list_reminders: 'list_reminders',
        get_today: 'get_today',
        list_tasks: 'list_tasks',
        list_goals: 'list_goals',
      };

      await bot.answerCallbackQuery(callbackQuery.id);

      if (data === 'list_notes') {
        // list_notes has no dedicated tool — query DB directly
        try {
          const notes = await db.getRecentNotes(userId, 15);
          if (notes.length === 0) {
            await safeSendMessage(bot, chatId, '📝 No notes saved yet.');
          } else {
            let reply = '*📝 All Notes*\n\n';
            notes.forEach((n, i) => {
              const date = fmt(n.created_at, 'MMM D, h:mm A');
              reply += (i + 1) + '\\. ' + escapeMd(n.content) + ' \\_(' + date + ')\\_\n\n';
            });
            await safeSendMessage(bot, chatId, reply.trim());
          }
        } catch (err) {
          console.error('list_notes callback error:', err.message);
          await bot.sendMessage(chatId, '❌ Could not retrieve notes.');
        }
        return;
      }

      // For list_reminders, get_today, list_tasks, list_goals — use executeTool
      try {
        const toolName = toolMap[data];
        const result = await tools.executeTool(userId, { name: toolName, args: {} });
        const msg = typeof result === 'object' ? result.message : result;
        await safeSendMessage(bot, chatId, msg);
      } catch (err) {
        console.error(data + ' callback error:', err.message);
        await bot.sendMessage(chatId, '❌ Could not retrieve data. Try again.');
      }
      return;
    }

    // ── 🔧 New-item prompt buttons ───────────────────────────────────────
    // new_reminder, new_task, new_goal
    if (data === 'new_reminder' || data === 'new_task' || data === 'new_goal') {
      await bot.answerCallbackQuery(callbackQuery.id);

      const prompts = {
        new_reminder: '⏰ *New Reminder*\n\nJust tell me what you want to be reminded about. Contoh:\n• "Remind me to call mom at 3pm"\n• "Ingatkan saya minum air setiap jam 9 pagi"',
        new_task: '📋 *New Task*\n\nDescribe your task and I\'ll create it. Contoh:\n• "Add task: Finish report by Friday, high priority"\n• "Tambah task: Kemas rumah before weekend"',
        new_goal: '🎯 *New Goal*\n\nWhat goal do you want to set? Contoh:\n• "Set goal: Learn TypeScript by end of month"\n• "Goal: Kurus 5kg dalam 2 bulan"',
      };

      await safeSendMessage(bot, chatId, prompts[data]);
      return;
    }

    // ── 🔧 Save search result as note ────────────────────────────────────
    if (data.startsWith('save_search_note:')) {
      const queryText = decodeURIComponent(data.split(':').slice(1).join(':'));
      await bot.answerCallbackQuery(callbackQuery.id, { text: '📝 Saved!' });

      try {
        // Extract the search result text from the message (strip Markdown formatting)
        const msgText = callbackQuery.message.text || callbackQuery.message.caption || '';
        // Remove the "🔍 Search: ..." header line and inline keyboard note
        const cleanText = msgText
          .replace(/^🔍[^\n]*\n+/s, '')
          .replace(/\n\n_🔍[^\n]*_$/, '')
          .trim();

        const noteContent = '🔍 Search: ' + queryText + '\n\n' + (cleanText || msgText);
        await db.addNote(userId, noteContent);

        // Remove the save button from the message
        const currentKeyboard = callbackQuery.message.reply_markup?.inline_keyboard || [];
        const newKeyboard = currentKeyboard
          .map(row => row.filter(btn => !btn.callback_data.startsWith('save_search_note:')))
          .filter(row => row.length > 0);

        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: newKeyboard },
            { chat_id: chatId, message_id: msgId }
          );
        } catch { /* non-critical */ }
      } catch (err) {
        console.error('save_search_note callback error:', err.message);
        await bot.sendMessage(chatId, '❌ Could not save note.');
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

      // 🔥 Track morning briefing streak on manual briefing too
      streaks.recordActivity(OWNER_ID, 'morning_briefing').catch(() => { });
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
      '/people — View remembered people & relationships\n' +
      '/person <name> — Search for a specific person\n' +
      '/verify — Review & resolve conflicting facts\n' +
      '/reflect — Generate daily reflection & insights\n' +
      '/patterns — View detected behavioral patterns (/patterns <type>)\n' +
      '/history — Search past conversations (/history <keyword>)\n' +
      '/status — Check API connections\n' +
      '/features — List all active capabilities & modules\n' +
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
        morning_briefing_time: 'Morning Briefing Time', reflection_time: 'Daily Reflection Time',
        weekly_review_time: 'Weekly Review Time', weather_location: 'Weather Location',
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

  // ── /features command — list all active capabilities ──────────────────────
  bot.onText(/\/features/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const message = formatFeaturesMarkdown();
      await safeSendMessage(bot, msg.chat.id, message);
    } catch (err) {
      console.error('/features error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve features list.');
    }
  });

  // ── /why command — explain the bot's last decision ────────────────────────
  bot.onText(/\/why/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const explanation = stateMachine.formatWhy(OWNER_ID);
      await safeSendMessage(bot, msg.chat.id, explanation);
    } catch (err) {
      console.error('/why error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve execution trace.');
    }
  });

  // ── /trace command — show last execution trace with full observability ────
  bot.onText(/\/trace(?:\s+(\d+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const count = match && match[1] ? Math.min(parseInt(match[1], 10), 10) : 3;
      const traces = stateMachine.getRecentTraces(OWNER_ID, count);

      if (traces.length === 0) {
        return bot.sendMessage(msg.chat.id, '🤷 No execution traces found. Send me a message first!');
      }

      let report = '🔍 **Last ' + traces.length + ' Execution Traces**\n\n';
      for (const t of traces) {
        report += '`' + t.traceId + '` — ' + (t.durationMs || '?') + 'ms — **' + t.finalState + '**\n';
        report += '  User: ' + (t.userMessage || '(none)').slice(0, 60) + '\n';
        report += '  Phases: ' + t.transitions.map(tr => tr.from + '→' + tr.to).join(', ') + '\n\n';
      }

      // Add latency stats
      const latencyStats = trace.getLatencyStats(OWNER_ID);
      if (Object.keys(latencyStats).length > 0) {
        report += '📊 **Avg Latency per Phase:**\n';
        for (const [phase, stats] of Object.entries(latencyStats)) {
          report += '  ' + phase + ': avg=' + stats.avgMs + 'ms, p95=' + stats.p95Ms + 'ms (n=' + stats.count + ')\n';
        }
      }

      await safeSendMessage(bot, msg.chat.id, report);
    } catch (err) {
      console.error('/trace error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve traces.');
    }
  });

  // ── /lifecycle command — show conversation phase & engagement ────────────
  bot.onText(/\/lifecycle/, async (msg) => {
    if (!isOwner(msg)) return;
    await bot.sendChatAction(msg.chat.id, 'typing');
    try {
      const report = lifecycle.formatLifecycle(OWNER_ID);
      await safeSendMessage(bot, msg.chat.id, report);
    } catch (err) {
      console.error('/lifecycle error:', err.message);
      await bot.sendMessage(msg.chat.id, '❌ Could not retrieve lifecycle info.');
    }
  });

  // ── Shared text processing (used by both text and voice messages) ─────────
  async function processUserText(bot, chatId, userId, userName, text, messageId = null) {
    // ── 🚫 User message dedup: skip if same text within 10 seconds ──────
    if (isDuplicateUserMessage(userId, text)) {
      console.log('[Bot] 🚫 Skipped duplicate message: "' + text.slice(0, 60) + '"');
      return; // silently ignore — user probably double-tapped send
    }
    cacheUserMessageResponse(userId, text, null); // mark as seen

    // ── 🔄 Re-send typing indicator every 4s (Telegram expires it after ~5s) ──
    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => { });
    }, 4000);
    // Initial typing indicator
    await bot.sendChatAction(chatId, 'typing');
    // Cleanup helper — call when done
    const stopTyping = () => { clearInterval(typingInterval); };

    // Start non-user-visible setup work in parallel while the typing
    // indicator is already shown.
    const ensureUserPromise = db.ensureUser(userId, userName);

    // ── 📡 Emit message:received event ──────────────────────────────────
    eventBus.emitSync(EVENTS.MESSAGE_RECEIVED, {
      userId,
      chatId,
      userName,
      text,
      timestamp: new Date().toISOString(),
    });

    // ── 🔌 Run plugin message hooks (before core processing) ────────────
    const [, pluginResults] = await Promise.all([
      ensureUserPromise,
      pluginRegistry.runMessageHooks({
        userId,
        chatId,
        message: text,
        bot,
      }),
    ]);
    // Log any plugin activity
    for (const pr of pluginResults) {
      console.log('[Bot] Plugin "' + pr.plugin + '" returned:', JSON.stringify(pr.result).slice(0, 100));
    }

    // ── � Lifecycle: track conversation phase ───────────────────────────
    const phaseInfo = lifecycle.onMessageReceived(userId);
    if (phaseInfo.transitioned) {
      console.log('[Lifecycle] Phase: ' + phaseInfo.previousPhase + ' → ' + phaseInfo.phase);
      eventBus.emitSync(EVENTS.LIFECYCLE_CHANGED, {
        userId,
        from: phaseInfo.previousPhase,
        to: phaseInfo.phase,
      });
    }

    // ── �🔍 Create execution pipeline (state machine + tracing) ─────────────
    const { sm, traceId } = executive.createPipeline(userId, text);
    let errorOccurred = false;

    try {
      // ── 🧠 Executive Decision ──────────────────────────────────────────
      // Pass recent message history so the executive can escalate to
      // DeepSeek when there's ongoing conversation context.
      const recentMsgs = (getHistory(userId) || []).slice(-6).map(m => m.content);
      const decision = await executive.decide(userId, text, sm, recentMsgs);
      console.log('[Executive] 📋 Decision: tier=' + decision.tier +
        ' | provider=' + decision.provider +
        ' | needs=' + JSON.stringify(decision.needs) +
        ' | wm=' + (decision.workingMemoryActive ? 'active' : 'idle') +
        ' | reason=' + decision.reason +
        ' | trace=' + traceId);

      // ── 📡 Emit intent:detected event ─────────────────────────────────
      eventBus.emitSync(EVENTS.INTENT_DETECTED, {
        userId,
        tier: decision.tier,
        category: decision.category,
        mood: decision.mood,
        language: decision.language,
        provider: decision.provider,
        traceId,
      });

      // ── Build executive context for ALL tiers ────────────────────────
      // ALL tiers get the same data (facts, reminders, people, working
      // memory, world model) to prevent context loss from misclassification.
      // Only the prompt STRUCTURE differs by tier (fast=short, deep=detailed).
      const llmOptions = {};
      llmOptions.executiveContext = await executive.buildContext(userId, decision, text, sm);
      // Pass executive's provider decision to LLM router so the most
      // appropriate model is used for each request.
      if (decision.provider) {
        llmOptions.provider = decision.provider;
      }
      // Pass tier so prompt structure stays appropriate (fast=short, deep=detailed)
      // while ALL tiers get the same underlying data.
      llmOptions.tier = decision.tier;

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

      // 🔥 Use summarized history with relevance-based pruning for context
      const history = getEffectiveHistory(userId, text);

      // ── 🧠 Context Switch Detection ────────────────────────────────────
      // If the last assistant message was asking a clarification question
      // (e.g., "What topic to search?") and the user's new message is a
      // completely different intent (e.g., "Set reminder"), inject a
      // context-reset marker to prevent the LLM from confusing intents.
      if (history.length >= 2) {
        const lastAssistant = [...history].reverse().find(h => h.role === 'assistant');
        const lastUser = [...history].reverse().find(h => h.role === 'user');

        if (lastAssistant && lastUser) {
          const assistantAskedQuestion = /(?:\?|apa\s*(?:topik|nama|tajuk|yang)|what\s*(?:topic|name|would)|nak\s*(?:cari|search|tahu)\s*(?:apa|tentang|pasal)|boleh\s*(?:bagi|beri|specify|nyatakan)|maksud\s*(?:awak|tu)|clarify|specific)/i.test(lastAssistant.content);
          const userNewIsCommand = /\b(?:set|buat|create|add|tambah|ingatkan|remind|simpan|save|cari|search|padam|delete|cancel|jadual|schedule)\b/i.test(text);
          const isDifferentIntent = assistantAskedQuestion && userNewIsCommand;

          if (isDifferentIntent) {
            console.log('[Bot] 🔄 Context switch detected — last assistant asked a question but user gave new command');
            // Inject a context separator before the user's latest message
            history.push({
              role: 'system',
              content: '[CONTEXT RESET] The user has ignored your previous question and is now giving a NEW, UNRELATED command. Treat this as a FRESH instruction. Do NOT reference your previous question or continue the previous topic. Focus ONLY on what the user is saying NOW.',
            });
            console.log('[Bot]    Last assistant said: ' + lastAssistant.content.slice(0, 100));
            console.log('[Bot]    User now says: ' + text.slice(0, 100));
          }
        }
      }

      // ── 🔥 ALL tiers use STREAMING for snappier UX ──────────────────
      let streamMsg = null;
      let streamEditFailed = false;
      let llmResponse;

      llmResponse = await llm.chatStream(userId, text, history, llmOptions, async (displayText) => {
        try {
          if (!streamMsg) {
            streamMsg = await bot.sendMessage(chatId, displayText);
          } else if (!streamEditFailed) {
            try {
              await bot.editMessageText(displayText, { chat_id: chatId, message_id: streamMsg.message_id });
            } catch (editErr) {
              console.warn('[Bot] Stream edit failed, stopping edits for this response:', editErr.message);
              streamEditFailed = true;
            }
          }
        } catch {
          streamMsg = null;
        }
      });

      // If tool call: delete the streaming placeholder (showed raw JSON fragments)
      if (llmResponse.type === 'tool' && streamMsg) {
        try { await bot.deleteMessage(chatId, streamMsg.message_id); } catch { }
        streamMsg = null;
      }

      // Add user message to history
      addToHistory(userId, 'user', text);

      console.log('[Bot] LLM response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');

      // ── Recovery: if LLM returned a message that looks like a fake action, retry once ──
      // Narrowed regex: only catch CLEAR hallucinated action claims, not normal conversation.
      // A hallucinated action message typically says "I've done X" or "Done! X created" etc.
      const actionKeywords = /\b(?:i've\s+(?:created|set|saved|added|updated|cancelled|deleted|removed|changed|recorded|noted|written|scheduled|planned)|i\s+have\s+(?:created|set|saved|added)|i\s+will\s+(?:remind|create|set|save|add|cancel|delete|notify|alert|send)|i'll\s+(?:remind|create|set|save|add|notify)|let\s+me\s+(?:remind|create|set|save|add|check|notify|schedule)|dah\s+(?:set|buat|masuk|confirm|simpan|ingat|create|save|cancel|delete|tambah|jadual|schedule|rekod|catat|tulis|nota|note|remind|reminder)|sudah\s+(?:set|create|tambah|save|cancel|delete|buat|simpan|masuk|jadual)|telah\s+(?:set|create|tambah|save|cancel|buat)|akan\s+(?:set|create|tambah|ingatkan|remind|notify|bagitahu|kasi\s*tau|bagi\s*tau)|all\s+set|got\s+it|done!|siap\s+dah|okay\s+dah|baik\s+(?:saya|aku)\s+(?:set|buat|create|ingatkan|remind)|noted!|dah\s+(?:noted|note|record)|sudah\s+(?:noted|note|record)|saya\s+(?:dah|sudah|telah|akan)\s+(?:set|buat|create|simpan|ingatkan|remind|jadual|schedule)|aku\s+(?:dah|sudah|telah|akan)\s+(?:set|buat|create|simpan|ingatkan|remind|jadual|schedule)|✅.*(?:reminder|event|task|note|goal|dah|set|create|save|buat|simpan)|reminder\s+(?:set|created|saved|dah|sudah)|event\s+(?:set|created|added|dah|sudah)|note\s+(?:saved|added|recorded|dah|sudah)|task\s+(?:created|added|set|dah|sudah)|goal\s+(?:created|set|dah|sudah)|dah\s+siap\s+set|dah\s+settle|settle\s+dah)\b/i;
      if (llmResponse.type === 'message' && actionKeywords.test(llmResponse.content)) {
        console.log('[Bot] ⚠️  LLM hallucinated an action! Retrying with correction...');
        const correctionMsg = '❌ SALAH! Kamu jawab guna natural language kononnya kamu dah buat sesuatu. Itu TIPU/HALLUCINATION.\n' +
          'Kamu TAK BOLEH buat apa-apa tindakan. Kamu MESTI balas dengan JSON tool call SAHAJA.\n' +
          'JANGAN cakap "Saya dah set..." atau "Dah siap..." — itu semua TIPU.\n\n' +
          'Contoh untuk reminder: {"type":"tool","name":"create_reminder","args":{"text":"Balik kerja","time":"2026-07-08T17:30:00+08:00"}}\n' +
          'Contoh untuk cancel: {"type":"tool","name":"cancel_reminder","args":{"reminder_id":3}}\n' +
          'Contoh untuk search: {"type":"tool","name":"web_search","args":{"query":"apa yang user nak cari"}}\n\n' +
          'Sekarang baca semula arahan user dan output JSON tool call yang BETUL. JANGAN letak apa-apa natural language — JSON SAHAJA!';

        // Build a fresh history without the hallucinated response
        const cleanHistory = history.filter(h => h.role !== 'assistant' || !actionKeywords.test(h.content));
        cleanHistory.push({ role: 'user', content: correctionMsg });

        llmResponse = await llm.chat(userId, text, cleanHistory, llmOptions);
        console.log('[Bot] Retry response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');
      }

      // ── Recovery: LLM fabricated a limitation that doesn't exist ──
      // "I can't access your reminders" / "Saya tak dapat akses" — THIS IS A LIE.
      // The bot HAS full access to all data. LLM is hallucinating a restriction.
      if (llmResponse.type === 'message') {
        const cannotAccessPattern = /\b(?:cannot\s+access|can'?t\s+access|don'?t\s+have\s+access|unable\s+to\s+(?:access|retrieve|fetch|get|see|view|read|check|pull|load)|tak\s+(?:dapat|boleh|ada)\s+(?:akses|access|lihat|baca|check|buka|capai)|tidak\s+(?:dapat|boleh|ada)\s+(?:akses|access|lihat|baca|check|buka|capai)|can'?t\s+(?:retrieve|fetch|get|see|view|pull|load|check|look\s*up)|unable\s+to\s+(?:access|retrieve|fetch)|no\s+access\s+to|don'?t\s+have\s+permission|not\s+able\s+to\s+(?:access|retrieve|get|see|check))\b/i;

        if (cannotAccessPattern.test(llmResponse.content)) {
          console.log('[Bot] ⚠️ LLM hallucinated a limitation! Retrying with correction...');
          console.log('[Bot]    LLM falsely claimed: ' + llmResponse.content.slice(0, 150));

          const correctionMsg = '❌ SALAH BESAR! Kamu cakap "cannot access" atau "tak dapat akses" — itu TIPU/HALLUCINATION.\n' +
            'Kamu ADA akses penuh ke SEMUA data — database, reminders, events, notes, tasks, goals, facts, SEMUA.\n' +
            'JANGAN sesekali cakap kamu tak boleh access sesuatu. Kamu BOLEH access semuanya.\n\n' +
            'Sekarang, baca semula arahan user dan execute tool call yang BETUL.\n' +
            'Contoh kalau user tanya pasal reminder: {"type":"tool","name":"list_reminders","args":{}}\n' +
            'Contoh kalau user tanya pasal schedule: {"type":"tool","name":"get_today","args":{}}\n\n' +
            'JANGAN letak natural language — JSON tool call SAHAJA!';

          const cleanHistory = history.filter(h => h.role !== 'assistant');
          cleanHistory.push({ role: 'user', content: correctionMsg });

          llmResponse = await llm.chat(userId, text, cleanHistory, llmOptions);
          console.log('[Bot] Retry (fabricated limitation) response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');
        }

        // ── Recovery: LLM fabricated user habits/routines ──────────────
        // "You usually sleep at...", "Your routine is...", "Awak biasanya..."
        // These are HALLUCINATIONS unless the fact exists in the DB.
        const fabricatedHabitPattern = /\b(?:you\s+(?:usually|always|normally|typically|tend\s+to|generally)|your\s+(?:routine|habit|sleep|bedtime|wake(?:\s*up)?\s*time|unwind|usual|typical|normal)\s+(?:is|are|seems|tends)|awak\s+(?:biasanya|selalu|selalunya|kebiasaannya|biasa)|routine\s+(?:awak|kau|anda)\s+(?:adalah|ialah|biasanya|selalu)|kebiasaan\s+(?:awak|kau|anda))\b/i;

        if (llmResponse.type === 'message' && fabricatedHabitPattern.test(llmResponse.content)) {
          // Only flag if user didn't just tell the bot this info
          const userJustToldThem = /\b(?:saya\s+(?:biasa|selalu|tidur|sleep|bangun|wake)|i\s+(?:usually|always|sleep|wake)|my\s+(?:routine|habit|sleep|bedtime))\b/i.test(text);

          if (!userJustToldThem) {
            console.log('[Bot] ⚠️ LLM fabricated user habit/routine! Injecting correction...');
            console.log('[Bot]    Fabricated claim: ' + llmResponse.content.slice(0, 150));

            // Don't retry the whole thing — just strip the fabricated claim
            llmResponse.content = '🤔 I shouldn\'t assume your habits. ' +
              'Could you tell me more? _(' + llmResponse.content.slice(0, 60).replace(/\*/g, '') + '...)_';
            console.log('[Bot]    Replaced with neutral response');
          }
        }

        // ── Recovery: LLM fabricated claims about user's life ──────────
        // Calls detectHumanFactHallucination from the validator for
        // comprehensive coverage: location, schedule, preferences, health,
        // emotions, relationships, finances, knowledge, future, intent,
        // numbers, identity (12 categories).
        if (llmResponse.type === 'message' && text) {
          try {
            const humanCheck = require('../llm/validator').detectHumanFactHallucination(
              llmResponse.content, [], text
            );
            if (humanCheck.isHallucination) {
              console.log('[Bot] ⚠️ LLM fabricated claims about user\'s life! Replacing...');
              console.log('[Bot]    Categories: ' + humanCheck.categories.join(', '));
              console.log('[Bot]    LLM said: ' + llmResponse.content.slice(0, 150));

              const isEnglish = /^[a-zA-Z\s.,!?'"\-()]{10,}$/.test(llmResponse.content.slice(0, 30));
              llmResponse.content = isEnglish
                ? "🤔 I shouldn't make assumptions about your life. Could you tell me more so I can help accurately?"
                : '🤔 Saya tak patut buat andaian tentang hidup awak. Boleh cerita lebih lanjut supaya saya boleh bantu dengan tepat?';
              console.log('[Bot]    Replaced with neutral response');
            }
          } catch { /* validator not available, skip */ }
        }
      }

      // ── Intercept: LLM fabricated a reminder list instead of calling tool ──
      // If LLM returns a message that looks like a formatted reminder list,
      // replace it with the actual tool call to get correct times from DB.
      if (llmResponse.type === 'message') {
        const content = llmResponse.content;

        // Pattern 1: "#4 - Text — pukul X:XX am", "#5 — Text", bullet lists
        const pattern1 = /(?:^|\n)\s*#\d+\s*[-–—]|upcoming\s*reminders|⏰.*reminder|reminder.*#\d+|•.*#\d+/im;

        // Pattern 2: Numbered list with date+time — "1. Text — 29 Jun 2026, 7:15 pm"
        const pattern2 = /(?:^|\n)\s*\d+\.\s+.+?\s*[-–—]\s*\d{1,2}\s+\w{3}\s+\d{4}\s*,?\s*\d{1,2}:\d{2}/im;

        // Pattern 3: Multiple "X. Text — time" format (two or more numbered items)
        const numberedItems = content.match(/(?:^|\n)\s*(\d+)\.\s+.+?[-–—].+?(?:\n|$)/gi);
        const hasMultipleNumberedItems = numberedItems && numberedItems.length >= 2;

        // Pattern 4: Content mentions "reminder" AND has multiple lines with dash-separated times
        const hasReminderWord = /\breminder(s)?\b/i.test(content);
        const timeEntries = content.match(/\d{1,2}[:.]\d{2}\s*(?:am|pm|AM|PM)/g);
        const hasMultipleTimes = timeEntries && timeEntries.length >= 2;

        const looksLikeReminderList =
          pattern1.test(content) ||
          pattern2.test(content) ||
          hasMultipleNumberedItems ||
          (hasReminderWord && hasMultipleTimes);

        // Also check: does the message mention multiple #numbers (like #4, #5)?
        const hashIdMatches = content.match(/#(\d+)/g);
        const hasMultipleHashIds = hashIdMatches && hashIdMatches.length >= 2;

        if (looksLikeReminderList || hasMultipleHashIds) {
          console.log('[Bot] ⚠️ LLM hallucinated reminder list! Replacing with real list_reminders tool call.');
          console.log('[Bot]    Detected by: pattern1=' + pattern1.test(content) +
            ' pattern2=' + pattern2.test(content) +
            ' numberedItems=' + hasMultipleNumberedItems +
            ' reminderWord+times=' + (hasReminderWord && hasMultipleTimes) +
            ' hashIds=' + hasMultipleHashIds);
          llmResponse = { type: 'tool', name: 'list_reminders', args: {} };
        }

        // ── Recovery: LLM acknowledged a search instead of calling web_search ──
        const searchAckPattern = /\b(?:kejap|sekejap|tunggu|search dulu|cari dulu|check dulu|cekidout dulu|aku search|aku cari|aku check|let me (?:search|look|check|find|google)|mencari|searching|checking|looking (?:up|for)|nak (?:aku|saya)?\s*(?:search|cari|check)|takut.*aku.*update|jap(?:eh)?\s*(?:aku|saya)?\s*(?:search|cari|check|tengok)|sek(?:ejap)?\s*(?:aku|saya)?\s*(?:search|cari|check)|bagi\s*(?:aku|saya)\s*(?:search|cari|check))/i;
        const userSearchIntentPattern = /\b(?:siapa|apa|bila|mana|berapa|cari|search|check|find|look\s*up|berita|news|terkini|latest|cuaca|weather|harga|price|stock|crypto|pm\s*malaysia|perdana\s*menteri|bola|football|soccer|score|liga|league|epl|ucl|hujan|rain|panas|ribut|storm|banjir|mendung|suhu|temperature|emas|bitcoin|btc|ringgit|myr|usd|trending|trend|viral|tular|isu\s*semasa)/i;

        if (searchAckPattern.test(content) && userSearchIntentPattern.test(text)) {
          console.log('[Bot] ⚠️ LLM acknowledged search but didn\'t call web_search! Forcing search...');
          console.log('[Bot]    LLM said:', content.slice(0, 150));
          console.log('[Bot]    User asked:', text.slice(0, 150));

          // Extract a clean search query from the user's original text
          let searchQuery = text
            .replace(/^(?:tolong\s+)?(?:cari|search|check|find|look\s*up)\s+/i, '')
            .replace(/\b(?:aku|saya|i|you|tolong|please|boleh\s+(?:tak|kah)?|can\s+you|nak\s+(?:tau|tahu)?)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

          // If query is too short after cleanup, use the original text
          if (searchQuery.length < 3) searchQuery = text;

          console.log('[Bot]    Search query:', searchQuery);
          llmResponse = { type: 'tool', name: 'web_search', args: { query: searchQuery } };
        }

        // ── 🔥 NEW Recovery: LLM gave confident answer about real-time info ──
        // If user asked about weather/news/price/etc. and LLM answered with a
        // message (not a tool call), it likely hallucinated. Force web_search.
        if (llmResponse.type === 'message' && userSearchIntentPattern.test(text) && !searchAckPattern.test(content)) {
          // Check if the response looks like a confident factual answer (not hedging)
          const hedgingPattern = /(?:tak\s*(?:pasti|tahu|dapat|boleh)|tidak\s*(?:pasti|tahu)|i'?\s*(?:m\s*not|don'?t)\s*(?:sure|certain|know)|maaf.*?(?:tak|tidak)\s*(?:tahu|pasti)|saya\s*(?:perlu|nak|akan)\s*(?:check|cari|search))/i;
          const isHedging = hedgingPattern.test(content);

          // Look for specific factual claims (numbers, locations, prices, etc.)
          const specificClaimPattern = /\b(?:cuaca|weather|hujan|rain|cerah|mendung|suhu|temperature|harga|price|rm\s*\d|\$\d+|ringgit|menang|kalah|score|gol|naik|turun|index|indeks|sedang|currently|kini|sekarang)\b/i;
          const hasSpecificClaim = specificClaimPattern.test(content);

          if (!isHedging && hasSpecificClaim) {
            console.log('[Bot] ⚠️ LLM gave confident factual answer about real-time topic — likely hallucination!');
            console.log('[Bot]    User asked:', text.slice(0, 150));
            console.log('[Bot]    LLM said:', content.slice(0, 150));

            // Extract a clean search query
            let searchQuery = text
              .replace(/^(?:tolong\s+)?(?:cari|search|check|find|look\s*up)\s+/i, '')
              .replace(/\b(?:aku|saya|i|you|tolong|please|boleh\s+(?:tak|kah)?|can\s+you|nak\s+(?:tau|tahu)?|agak\s*(?:ii|ih|lah)?)\b/gi, '')
              .replace(/\?/g, '')
              .replace(/\s+/g, ' ')
              .trim();

            if (searchQuery.length < 3) searchQuery = text;

            console.log('[Bot]    Forcing web_search with query:', searchQuery.slice(0, 100));
            llmResponse = { type: 'tool', name: 'web_search', args: { query: searchQuery } };
          }
        }
      }

      if (llmResponse.type === 'message') {
        // Plain response — WARNING: no DB action occurs here
        // ⏰ Guard: fix any hallucinated time before sending
        llmResponse.content = fixHallucinatedGreeting(llmResponse.content);
        llmResponse.content = fixHallucinatedTime(llmResponse.content);
        console.log('[Bot] Message response (no tool executed):', llmResponse.content.slice(0, 150));
        addToHistory(userId, 'assistant', llmResponse.content);
        stopTyping();
        await safeSendMessage(bot, chatId, llmResponse.content);

        // ── 📡 Emit message:sent event ───────────────────────────────────
        eventBus.emitSync(EVENTS.MESSAGE_SENT, {
          userId,
          chatId,
          type: 'message',
          content: llmResponse.content.slice(0, 200),
          timestamp: new Date().toISOString(),
        });

        // ── Post-processing guided by executive (OFFLOADED TO QUEUE) ──────
        const postActions = executive.decidePostProcessing(decision, llmResponse);

        // Core working memory update stays sync (needed for context continuity)
        if (postActions.updateWorkingMemory) {
          const topic = extractMainTopic(text, llmResponse.content);
          const exchangeSummary = buildExchangeSummary(text, llmResponse.content);
          const flowHint = detectConversationFlow(text, llmResponse.content);

          executive.workingMemory.update(userId, {
            contextNotes: 'Last exchange: user asked "' + text.slice(0, 100) + '" → bot responded',
            lastExchangeSummary: exchangeSummary,
            conversationFlow: flowHint || undefined,
          });
          if (topic) {
            executive.workingMemory.update(userId, { addTopic: topic });
          }
        }

        // 🚀 Offload heavy background tasks to queue (non-blocking!) ─────
        const bgJobs = [];
        if (postActions.extractFacts) {
          bgJobs.push({ name: 'extract-facts', data: { userId, userText: text, botResponse: llmResponse.content } });
        }
        if (postActions.extractPeople) {
          bgJobs.push({ name: 'extract-people', data: { userId, userText: text, botResponse: llmResponse.content } });
        }
        if (postActions.updateDomains) {
          bgJobs.push({ name: 'update-domains', data: { userId, text } });
        }
        if (postActions.runSelfEval) {
          bgJobs.push({ name: 'evaluate-quality', data: { userId, evalData: { userMessage: text, botResponse: llmResponse.content, tier: decision.tier, category: decision.category } } });
        }
        // Pattern tracking always runs
        bgJobs.push({ name: 'track-patterns', data: { userId, entry: { role: 'user', content: text } } });
        bgJobs.push({ name: 'track-patterns', data: { userId, entry: { role: 'assistant', content: llmResponse.content } } });
        // Smart summarization
        const currentHistory = historyModule.getHistory(userId);
        if (currentHistory.length >= historyModule.SUMMARIZE_THRESHOLD - 5) {
          bgJobs.push({ name: 'smart-summarize', data: { userId, history: currentHistory } });
        }
        // Fire-and-forget: don't await queue enqueue
        queueSystem.enqueuePostProcessBatch(bgJobs);

        console.log('[Executive] ✅ ' + decision.tier.toUpperCase() + ' path complete | post: facts=' + postActions.extractFacts + ' people=' + postActions.extractPeople + ' wm=' + postActions.updateWorkingMemory + ' domains=' + postActions.updateDomains + ' eval=' + postActions.runSelfEval + ' | queued=' + bgJobs.length + ' jobs');

      } else if (llmResponse.type === 'tool') {
        // ── 🔌 Run plugin tool call hooks (before execution) ───────────────
        const interceptResult = await pluginRegistry.runToolCallHooks(
          llmResponse.name, llmResponse.args, userId
        );
        if (interceptResult.intercepted) {
          console.log('[Bot] 🔌 Tool call intercepted by plugin "' + interceptResult.plugin + '"');
          result = interceptResult.result;
        } else {
          // Execute tool (try agent layer first, fall back to direct)
          console.log('[Bot] Executing tool:', llmResponse.name, JSON.stringify(llmResponse.args).slice(0, 200));
          const toolStartMs = Date.now();
          try {
            // ── Try agent routing first (Item #6: Agent Layer Integration) ──
            const agentResult = await agentRegistry.dispatchToolCall(
              llmResponse.name, llmResponse.args, userId
            );
            if (agentResult && agentResult.success) {
              result = agentResult.result;
              console.log('[Bot] ✅ Handled by agent: ' + (agentResult.agent || 'unknown'));
            } else {
              // Fall back to direct tool execution
              result = await tools.executeTool(userId, {
                name: llmResponse.name,
                args: llmResponse.args,
              });
            }
            const toolDurationMs = Date.now() - toolStartMs;
            console.log('[Bot] Tool result:', typeof result === 'object' ? (result.type || 'object') : String(result).slice(0, 150));

            // 📡 Emit tool:executed event
            eventBus.emitSync(EVENTS.TOOL_EXECUTED, {
              userId,
              toolName: llmResponse.name,
              args: llmResponse.args,
              success: true,
              durationMs: toolDurationMs,
            });

            // Log tool call for observability
            trace.logToolCall(llmResponse.name, llmResponse.args, result, toolDurationMs);
          } catch (toolErr) {
            console.error('[Bot] Tool execution error:', toolErr.message);

            // 📡 Emit tool:failed event
            eventBus.emitSync(EVENTS.TOOL_FAILED, {
              userId,
              toolName: llmResponse.name,
              args: llmResponse.args,
              error: toolErr.message,
            });

            trace.logToolCall(llmResponse.name, llmResponse.args, { error: toolErr.message }, Date.now() - toolStartMs);
            result = 'I tried to do that but ran into a problem. Please try again.';
          }
        }

        // ── State machine: tools executed ────────────────────────────────
        executive.transitionToolsExecuted(sm, {
          toolName: llmResponse.name,
          toolSuccess: !(result && result.error),
        });

        // ── Confirmation flow: if tool returned {type:'confirm', message} ──
        if (result && typeof result === 'object' && result.type === 'confirm') {
          // ⏰ Guard: fix any hallucinated times in the confirm message
          result.message = fixHallucinatedGreeting(result.message);
          result.message = fixHallucinatedTime(result.message);
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
          // ── Post-processing guided by executive (OFFLOADED TO QUEUE) ──────
          const postActions = executive.decidePostProcessing(decision, { type: 'message', content: result.message });

          // Core working memory stays sync
          if (postActions.updateWorkingMemory) {
            const topic = extractMainTopic(text, result.message);
            const exchangeSummary = buildExchangeSummary(text, result.message);
            const flowHint = detectConversationFlow(text, result.message);

            executive.workingMemory.update(userId, {
              contextNotes: 'Confirm flow: ' + text.slice(0, 100),
              lastExchangeSummary: exchangeSummary,
              conversationFlow: flowHint || undefined,
            });
            if (topic) {
              executive.workingMemory.update(userId, { addTopic: topic });
            }
          }

          // 🚀 Offload to queue
          const bgJobs = [];
          if (postActions.extractFacts) bgJobs.push({ name: 'extract-facts', data: { userId, userText: text, botResponse: result.message } });
          if (postActions.extractPeople) bgJobs.push({ name: 'extract-people', data: { userId, userText: text, botResponse: result.message } });
          if (postActions.updateDomains) bgJobs.push({ name: 'update-domains', data: { userId, text } });
          if (postActions.runSelfEval) bgJobs.push({ name: 'evaluate-quality', data: { userId, evalData: { userMessage: text, botResponse: result.message, tier: decision.tier, category: decision.category } } });
          bgJobs.push({ name: 'track-patterns', data: { userId, entry: { role: 'user', content: text } } });
          bgJobs.push({ name: 'track-patterns', data: { userId, entry: { role: 'assistant', content: result.message } } });
          queueSystem.enqueuePostProcessBatch(bgJobs);

          // ── 🏁 Finish pipeline (confirm flow exits early) ──────────────
          stopTyping();
          executive.finishPipeline(sm, {
            tier: decision.tier,
            provider: decision.provider,
            responseType: 'confirm',
          });

          return; // Done — wait for user to click button or type "ya"
        }

        // ── Smart Follow-Up Cascade (replaces hardcoded note→reminder logic) ──
        let followupResult = null;
        try {
          const cascadeSuggestion = await cascade.getCascadeSuggestion(
            userId, llmResponse.name, llmResponse.args, text
          );
          if (cascadeSuggestion) {
            followupResult = cascadeSuggestion;
            console.log('[Bot] 🔗 Cascade triggered: ' + cascadeSuggestion.type);
          }
        } catch (cascadeErr) {
          console.warn('[Bot] Cascade check failed (non-fatal):', cascadeErr.message);
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
            const summaryResponse = await llm.chatMimo(userId, text, summarizeHistory);
            console.log('[Bot] Web search re-summary result:', summaryResponse.type, summaryResponse.content ? summaryResponse.content.slice(0, 150) : '');

            if (summaryResponse.type === 'message' && summaryResponse.content) {
              // 🚫 Guard: if the summary looks like raw JSON (LLM didn't follow format),
              // discard it and use the raw search results instead
              const trimmed = summaryResponse.content.trim();
              if (trimmed.startsWith('{') || trimmed.startsWith('```')) {
                console.warn('[Bot] ⚠️ Web search summary looks like raw JSON, discarding and using raw results');
              } else {
                result = fixHallucinatedGreeting(summaryResponse.content);
                result = fixHallucinatedTime(result);
              }
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
        let finalResult = followupText ? resultText + '\n\n' + followupText : resultText;

        // ⏰ NOTE: Do NOT run fixHallucinatedTime on tool results.
        // Tool results contain accurate times from the DB (reminders, events, etc.).
        // fixHallucinatedTime would incorrectly replace those times with the current time.
        addToHistory(userId, 'assistant', finalResult);

        // Determine inline keyboard based on tool type
        let inlineKeyboard = null;
        if (isStructured) {
          switch (result.tool) {
            case 'create_reminder':
            case 'update_reminder':
              inlineKeyboard = [
                [{ text: '✏️ Edit', callback_data: 'edit_reminder:' + result.id }, { text: '❌ Cancel', callback_data: 'cancel_reminder:' + result.id }],
                [{ text: '📋 View All Reminders', callback_data: 'list_reminders' }],
              ];
              break;
            case 'create_event':
            case 'update_event':
              inlineKeyboard = [
                [{ text: '✏️ Edit', callback_data: 'edit_event:' + result.id }, { text: '❌ Cancel', callback_data: 'cancel_event:' + result.id }],
                [{ text: '📅 View Today', callback_data: 'get_today' }],
              ];
              break;
            case 'add_note':
              inlineKeyboard = [
                [{ text: '❌ Delete', callback_data: 'delete_note:' + result.id }],
                [{ text: '📝 View All Notes', callback_data: 'list_notes' }],
              ];
              break;
            case 'set_fact':
              inlineKeyboard = [[
                { text: '❌ Forget', callback_data: 'forget_fact:' + encodeURIComponent(result.meta.key) },
              ]];
              break;
            case 'create_task':
              inlineKeyboard = [
                [{ text: '🚀 Start', callback_data: 'start_task:' + result.id }, { text: '✅ Done', callback_data: 'complete_task:' + result.id }],
                [{ text: '❌ Cancel', callback_data: 'cancel_task:' + result.id }, { text: '📋 All Tasks', callback_data: 'list_tasks' }],
              ];
              break;
            case 'create_goal':
              inlineKeyboard = [
                [{ text: '🏆 Complete', callback_data: 'complete_goal:' + result.id }, { text: '🗑️ Abandon', callback_data: 'abandon_goal:' + result.id }],
                [{ text: '🎯 All Goals', callback_data: 'list_goals' }],
              ];
              break;
            // List results — add contextual quick follow-ups
            case 'list_reminders':
              inlineKeyboard = [[
                { text: '➕ Set New Reminder', callback_data: 'new_reminder' },
              ]];
              break;
            case 'list_tasks':
              inlineKeyboard = [[
                { text: '➕ New Task', callback_data: 'new_task' },
                { text: '🎯 Goals', callback_data: 'list_goals' },
              ]];
              break;
            case 'list_goals':
              inlineKeyboard = [[
                { text: '➕ New Goal', callback_data: 'new_goal' },
                { text: '📋 Tasks', callback_data: 'list_tasks' },
              ]];
              break;
          }
        }

        // Add web_search follow-up button for search results
        if (llmResponse.name === 'web_search') {
          inlineKeyboard = [[
            { text: '📝 Save as Note', callback_data: 'save_search_note:' + encodeURIComponent(text.slice(0, 50)) },
          ]];
        }

        // ── 🔄 Stop typing indicator before showing result ────────────────
        stopTyping();

        if (inlineKeyboard) {
          let keyboardSent = false;
          try {
            await bot.sendMessage(chatId, finalResult, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: inlineKeyboard },
            });
            keyboardSent = true;
          } catch (mdErr) {
            console.error('[Bot] Inline keyboard Markdown send failed: ' + mdErr.message);
            try {
              await bot.sendMessage(chatId, finalResult, {
                reply_markup: { inline_keyboard: inlineKeyboard },
              });
              keyboardSent = true;
            } catch (plainErr) {
              console.error('[Bot] Inline keyboard plain send also failed: ' + plainErr.message);
            }
          }
          // ── Fallback: if keyboard send failed entirely, try without keyboard ──
          if (!keyboardSent) {
            console.log('[Bot] ⚠️ Keyboard send failed, falling back to safeSendMessage without keyboard');
            await safeSendMessage(bot, chatId, finalResult);
          }
        } else {
          await safeSendMessage(bot, chatId, finalResult);
        }

        // ── 💬 Conversational follow-up after all tool executions ────────
        // After any structured tool result, continue the conversation naturally.
        // Uses full history + working memory so the reply is contextually aware.
        // web_search is already handled above (LLM re-summarisation).
        if (isStructured) {
          try {
            const toolResultText = result.message
              ? result.message.replace(/[*_`[\]()~>#+=|{}.!]/g, '').slice(0, 200)
              : '';
            const followupPrompt =
              'The "' + result.tool.replace(/_/g, ' ') + '" action just completed: "' + toolResultText + '"\n\n' +
              'Write a very brief natural follow-up to continue the conversation (1-2 sentences max). ' +
              'Match the user\'s language exactly (BM/English/rojak). ' +
              'Do NOT repeat or describe the action result — just continue naturally.\n' +
              'Respond as JSON: {"type":"message","content":"your reply"}';

            // Pass real conversation history + working memory context
            const fupResponse = await llm.chat(userId, followupPrompt, history, {
              provider: 'ilmu',
              executiveContext: llmOptions.executiveContext,
              tier: 'fast',
            });
            if (fupResponse?.type === 'message' && fupResponse.content) {
              const trimmed = fupResponse.content.trim();
              if (!trimmed.startsWith('{') && !trimmed.startsWith('```') && trimmed.length > 2) {
                await bot.sendChatAction(chatId, 'typing').catch(() => { });
                await new Promise(r => setTimeout(r, 700));
                await safeSendMessage(bot, chatId, fupResponse.content);
                addToHistory(userId, 'assistant', fupResponse.content);
              }
            }
          } catch (fupErr) {
            console.warn('[Bot] Tool follow-up skipped:', fupErr.message);
          }
        }

        // ── ✅ Emoji reaction on user's message for tool execution ───────
        if (messageId) {
          try {
            await bot.setMessageReaction(chatId, messageId, {
              reaction: [{ type: 'emoji', emoji: '✅' }],
            });
          } catch {
            // setMessageReaction may not be available on older bot API versions
            // Fallback: silently ignore — reactions are a nice-to-have
          }
        }

        // ── Post-processing guided by executive (OFFLOADED TO QUEUE) ──────
        const postActions = executive.decidePostProcessing(decision, llmResponse);

        // 🚀 Offload to queue
        const bgJobs = [];
        if (postActions.extractFacts) bgJobs.push({ name: 'extract-facts', data: { userId, userText: text, botResponse: finalResult } });
        if (postActions.extractPeople) bgJobs.push({ name: 'extract-people', data: { userId, userText: text, botResponse: finalResult } });
        if (postActions.updateDomains) bgJobs.push({ name: 'update-domains', data: { userId, text } });
        if (postActions.runSelfEval) bgJobs.push({ name: 'evaluate-quality', data: { userId, evalData: { userMessage: text, botResponse: finalResult, tier: decision.tier, category: decision.category, toolName: llmResponse.name, toolSuccess: true } } });
        bgJobs.push({ name: 'track-patterns', data: { userId, entry: { role: 'user', content: text } } });
        bgJobs.push({ name: 'track-patterns', data: { userId, entry: { role: 'assistant', content: finalResult, toolUsed: llmResponse.name } } });
        queueSystem.enqueuePostProcessBatch(bgJobs);

        console.log('[Executive] ✅ ' + decision.tier.toUpperCase() + ' path complete (tool=' + llmResponse.name + ') | post: facts=' + postActions.extractFacts + ' people=' + postActions.extractPeople + ' wm=' + postActions.updateWorkingMemory + ' domains=' + postActions.updateDomains + ' eval=' + postActions.runSelfEval + ' | queued=' + bgJobs.length + ' jobs');

      } else {
        console.log('[Bot] Unknown LLM response type:', llmResponse.type);
        await bot.sendMessage(chatId, 'Something went wrong. Try again?');
      }

      // ── 🏁 Finish pipeline successfully ──────────────────────────────────
      executive.finishPipeline(sm, {
        tier: decision.tier,
        provider: decision.provider,
        responseType: llmResponse.type,
      });

    } catch (err) {
      stopTyping();
      console.error('[Bot] Message handler error:', err.message, err.stack?.split('\n')[1] || '');

      // ── 📡 Emit error:occurred event ───────────────────────────────────
      eventBus.emitSync(EVENTS.ERROR_OCCURRED, {
        source: 'bot:message_handler',
        userId,
        message: text?.slice(0, 100),
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join('\n'),
        timestamp: new Date().toISOString(),
      });

      // ── Record error in state machine ───────────────────────────────────
      if (sm && !errorOccurred) {
        sm.error(err);
      }

      let errorMsg = 'Something went wrong. ';
      if (err.response && err.response.status === 401) {
        errorMsg += 'Check your API key.';
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorMsg += 'Can\'t reach the API. Check your internet connection.';
      } else if (err.response && err.response.status === 400) {
        // Telegram 400 — likely a message formatting issue, but the action likely succeeded
        errorMsg += 'Tapi action tadi mungkin dah jalan. Guna /reminders untuk check.';
      } else if (err.response && err.response.status >= 500) {
        errorMsg += 'Telegram server issue. Please try again in a moment.';
      } else {
        errorMsg += 'Please try again.';
      }
      await safeSendMessage(bot, chatId, errorMsg);
    }
  }

  // ── /recap command — summarize recent conversations ────────────────────
  bot.onText(/\/recap(?:\s+(\d+))?/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    await bot.sendChatAction(chatId, 'typing');

    try {
      const count = Math.min(parseInt(match[1] || '15', 10), 50);
      const history = getHistory(OWNER_ID);

      if (history.length < 3) {
        return bot.sendMessage(chatId, '📭 Not enough conversation history to recap. Chat with me more!');
      }

      // Take the last N messages for summarization
      const recentMessages = history.slice(-count);
      const conversationText = recentMessages
        .map(m => (m.role === 'user' ? '👤' : '🤖') + ' ' + m.content.slice(0, 200))
        .join('\n\n');

      const recapPrompt =
        '📋 Summarize this Telegram chat conversation into a concise recap.\n\n' +
        'Rules:\n' +
        '• Group by topic, not chronologically\n' +
        '• Highlight decisions made, reminders set, and key info shared\n' +
        '• Keep it brief — bullet points preferred\n' +
        '• Match the user\'s language (BM / English / rojak)\n\n' +
        '─────────────── CONVERSATION ───────────────\n' +
        conversationText + '\n' +
        '──────────────────────────────────────────────\n\n' +
        'Respond with: {"type":"message","content":"*📋 Conversation Recap*\n\n...your recap here..."}';

      const recapResponse = await llm.chatMimo(OWNER_ID, 'Recap my conversations', [{ role: 'user', content: recapPrompt }], { minimal: false });

      if (recapResponse.type === 'message' && recapResponse.content) {
        const recap = fixHallucinatedGreeting(recapResponse.content);
        await safeSendMessage(bot, chatId, recap);
      } else {
        await bot.sendMessage(chatId, '❌ Could not generate recap. Try again.');
      }
    } catch (err) {
      console.error('/recap error:', err.message);
      await bot.sendMessage(chatId, '❌ Could not generate recap.');
    }
  });

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
          if (confirmed.envKey === 'MORNING_BRIEFING_TIME' || confirmed.envKey === 'REFLECTION_TIME' || confirmed.envKey === 'WEEKLY_REVIEW_TIME') {
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

    await processUserText(bot, chatId, userId, userName, msg.text, msg.message_id);

    // 🔥 Track daily chat streak (fire-and-forget, non-blocking)
    streaks.recordActivity(userId, 'daily_chat').then(result => {
      if (result && result.isNewDay && result.current_streak > 1) {
        const milestone = streaks.getMilestoneMessage(result.current_streak, 'daily_chat');
        if (milestone) {
          safeSendMessage(bot, chatId, milestone).catch(() => { });
        }
      }
    }).catch(() => { });
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
      await processUserText(bot, chatId, userId, userName, transcribedText, msg.message_id);

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

  // ── Photo message handler (ILMU Vision v1.3) ────────────────────────────
  bot.on('photo', async (msg) => {
    if (!isOwner(msg)) return;

    const userId = OWNER_ID;
    const chatId = msg.chat.id;

    // Get the largest photo (Telegram sends multiple sizes, last = largest)
    const photo = msg.photo[msg.photo.length - 1];
    if (!photo) return;

    if (!vision.isAvailable() && !process.env.ILMU_API_KEY) {
      await safeSendMessage(bot, chatId,
        '🖼️ Image analysis is powered by ILMU Vision v1.3.\n' +
        'Set *ILMU_API_KEY* in your `.env` file to enable this feature.\n\n' +
        '_Your image is received, but I can\'t analyze it yet._');
      return;
    }

    const caption = msg.caption || '';
    console.log('[Bot] 🖼️ Photo received' + (caption ? ' with caption: "' + caption.slice(0, 80) + '"' : ''));

    await bot.sendChatAction(chatId, 'typing');

    try {
      // Download the photo from Telegram
      const fileInfo = await bot.getFile(photo.file_id);
      const fileUrl = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + fileInfo.file_path;

      const axios = require('axios');
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 20000 });
      const imageBuffer = Buffer.from(response.data);

      // Determine prompt from caption or use default
      let prompt = null;
      let language = null;

      if (caption) {
        // Use caption as the prompt
        prompt = caption;
        // Detect language
        if (/[a-zA-Z]{3,}/.test(caption) && !/\b(?:apa|siapa|bila|mana|bagaimana|kenapa|boleh|nak|tak|tu|ni|ni|lah|kah)\b/i.test(caption)) {
          language = 'en';
        } else {
          language = 'ms';
        }
      } else {
        prompt = 'Terangkan gambar ini dalam Bahasa Melayu secara ringkas dan padat.';
        language = 'ms';
      }

      const analysis = await vision.analyzeImage({
        imageBuffer,
        mimeType: 'image/jpeg',
        prompt,
        language,
      });

      if (analysis) {
        // Build response — keep it concise for Telegram
        const displayText = caption
          ? analysis  // user gave a specific question, just show answer
          : '🖼️ ' + analysis;

        // If analysis is long, truncate
        const maxLen = 800;
        const finalText = displayText.length > maxLen
          ? displayText.slice(0, maxLen) + '…'
          : displayText;

        await safeSendMessage(bot, chatId, finalText);

        // Track for pattern recognition
        patterns.trackMessage(userId, { role: 'user', content: '[PHOTO] ' + (caption || '(no caption)') });
        patterns.trackMessage(userId, { role: 'assistant', content: '[VISION] ' + analysis.slice(0, 200) });
      } else {
        await safeSendMessage(bot, chatId, '🖼️ Sorry, I couldn\'t analyze this image. Try again or send a clearer photo.');
      }
    } catch (err) {
      console.error('[Bot] Photo processing error:', err.message);
      await safeSendMessage(bot, chatId, '🖼️ Failed to process the image. It may be too large or in an unsupported format.');
    }
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
  });

  return bot;
}

module.exports = { createBot };
