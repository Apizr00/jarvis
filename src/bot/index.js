// src/bot/index.js
// Telegram bot - handles all incoming messages
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('../db');
const llm = require('../llm/deepseek');
const tools = require('../tools');

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);

// Simple in-memory conversation history per user (last 10 turns)
const conversationHistory = {};

function getHistory(userId) {
  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  return conversationHistory[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  // Keep last 10 messages to avoid huge prompts
  if (history.length > 10) history.splice(0, history.length - 10);
}

function createBot() {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  console.log('🤖 Jarvis bot is online and polling...');

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
        'Hey ' + name + '! I\'m *Jarvis*, your personal assistant. 🤖\n\n' +
        'You can talk to me naturally. Try:\n' +
        '• "Remind me to call mum at 6pm"\n' +
        '• "Add gym to my calendar tomorrow at 7am"\n' +
        '• "Note: look into React Native"\n' +
        '• "What\'s my schedule today?"\n' +
        '• "Remember that I prefer dark mode"\n\n' +
        'I\'m ready when you are.';

      await bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown' });
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
    await bot.sendMessage(msg.chat.id, result, { parse_mode: 'Markdown' });
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
      reply += (i + 1) + '. ' + n.content + ' _(' + date + ')_\n\n';
    });
    await bot.sendMessage(msg.chat.id, reply.trim(), { parse_mode: 'Markdown' });
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
      reply += '• *' + f.key + ':* ' + f.value + '\n';
    });
    await bot.sendMessage(msg.chat.id, reply.trim(), { parse_mode: 'Markdown' });
  });

  // ── /help command ─────────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isOwner(msg)) return;
    const help =
      '*Jarvis Commands* 🤖\n\n' +
      '/start — Wake up Jarvis\n' +
      '/today — See today\'s schedule\n' +
      '/notes — View recent notes\n' +
      '/memory — See stored facts\n' +
      '/help — This message\n\n' +
      '*Or just talk to me naturally!*\n' +
      'Examples:\n' +
      '• "Remind me to take meds at 8pm"\n' +
      '• "Add standup to calendar at 9am tomorrow"\n' +
      '• "Note: follow up with client on Friday"\n' +
      '• "Remember I wake up at 6am"\n' +
      '• "What\'s my day looking like?"';
    await bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
  });

  // ── Main message handler ──────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    // Skip commands (handled above) and non-owner messages
    if (!isOwner(msg)) return;
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;

    const userId = OWNER_ID;
    const chatId = msg.chat.id;

    await db.ensureUser(userId, msg.from.first_name || 'Owner');

    // Show typing indicator
    await bot.sendChatAction(chatId, 'typing');

    try {
      const history = getHistory(userId);
      const llmResponse = await llm.chat(userId, msg.text, history);

      // Add user message to history
      addToHistory(userId, 'user', msg.text);

      if (llmResponse.type === 'message') {
        // Plain response
        addToHistory(userId, 'assistant', llmResponse.content);
        await bot.sendMessage(chatId, llmResponse.content, { parse_mode: 'Markdown' });

      } else if (llmResponse.type === 'tool') {
        // Execute tool and send result
        const result = await tools.executeTool(userId, {
          name: llmResponse.name,
          args: llmResponse.args,
        });
        addToHistory(userId, 'assistant', result);
        await bot.sendMessage(chatId, result, { parse_mode: 'Markdown' });

      } else {
        await bot.sendMessage(chatId, 'Something went wrong. Try again?');
      }

    } catch (err) {
      console.error('Message handler error:', err.message);
      let errorMsg = 'Something went wrong. ';
      if (err.response && err.response.status === 401) {
        errorMsg += 'Check your DeepSeek API key.';
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorMsg += 'Can\'t reach DeepSeek API. Check your internet connection.';
      } else {
        errorMsg += 'Please try again.';
      }
      await bot.sendMessage(chatId, errorMsg);
    }
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
  });

  return bot;
}

module.exports = { createBot };
