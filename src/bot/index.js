// src/bot/index.js
// Telegram bot - handles all incoming messages
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { dayjs, fmt } = require('../utils/datetime');
const db = require('../db');
const llm = require('../llm');
const tools = require('../tools');
const { escapeMd, safeSendMessage } = tools;
const { buildBriefingMessage } = require('../scheduler');
const { getQuote } = require('../tools/quote');
const { transcribe, downloadVoiceFile } = require('../llm/whisper');
const { getApiStatus, formatStatusMessage } = require('../api/status');

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

  // ── Callback query handler: cancel reminders ──────────────────────────────
  bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const msgId = callbackQuery.message.message_id;

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
      '/memory — See stored facts\n' +
      '/status — Check API connections\n' +
      '/help — This message\n\n' +
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
      const history = getHistory(userId);
      let llmResponse = await llm.chat(userId, text, history);

      // Add user message to history
      addToHistory(userId, 'user', text);

      console.log('[Bot] LLM response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');

      // ── Recovery: if LLM returned a message that looks like a fake action, retry once ──
      const actionKeywords = /\b(cancelled|updated?|changed|deleted|created|saved|noted|remembered|reminder\s*#)\b/i;
      if (llmResponse.type === 'message' && actionKeywords.test(llmResponse.content)) {
        console.log('[Bot] ⚠️  LLM hallucinated an action! Retrying with correction...');
        const correctionMsg = '❌ You responded with natural language claiming you did something. ' +
          'That is WRONG. You have NO ability to act. You MUST respond with ONLY a JSON tool call. ' +
          'For example: {"type":"tool","name":"cancel_reminder","args":{"reminder_id":4}}\n\n' +
          'Now re-read the user request and output the CORRECT JSON tool call.';

        // Build a fresh history without the hallucinated response
        const cleanHistory = history.filter(h => h.role !== 'assistant' || !actionKeywords.test(h.content));
        cleanHistory.push({ role: 'user', content: correctionMsg });

        llmResponse = await llm.chat(userId, text, cleanHistory);
        console.log('[Bot] Retry response type:', llmResponse.type, llmResponse.name ? '| tool=' + llmResponse.name : '');
      }

      if (llmResponse.type === 'message') {
        // Plain response — WARNING: no DB action occurs here
        console.log('[Bot] Message response (no tool executed):', llmResponse.content.slice(0, 150));
        addToHistory(userId, 'assistant', llmResponse.content);
        await safeSendMessage(bot, chatId, llmResponse.content);

      } else if (llmResponse.type === 'tool') {
        // Execute tool
        console.log('[Bot] Executing tool:', llmResponse.name, JSON.stringify(llmResponse.args).slice(0, 200));
        let result;
        try {
          result = await tools.executeTool(userId, {
            name: llmResponse.name,
            args: llmResponse.args,
          });
          console.log('[Bot] Tool result:', result.slice(0, 150));
        } catch (toolErr) {
          console.error('[Bot] Tool execution error:', toolErr.message);
          result = 'I tried to do that but ran into a problem. Please try again.';
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
              console.log('[Bot] Smart follow-up reminder created:', followupResult.slice(0, 150));
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
              result + '\n' +
              '──────────────────────────────────────────────────\n\n' +
              'Now write a natural, friendly reply summarizing these results. ' +
              'Respond with: {"type":"message","content":"your summary here"}';

            const summarizeHistory = [{ role: 'user', content: summarizePrompt }];
            const summaryResponse = await llm.chat(userId, text, summarizeHistory);
            console.log('[Bot] Web search re-summary result:', summaryResponse.type, summaryResponse.content ? summaryResponse.content.slice(0, 150) : '');

            if (summaryResponse.type === 'message' && summaryResponse.content) {
              result = summaryResponse.content;
            }
            // If LLM failed to re-summarize, fall through and use raw result
          } catch (summaryErr) {
            console.warn('[Bot] Web search re-summary failed (using raw results):', summaryErr.message);
            // result stays as raw search results
          }
        }

        // Combine results
        const finalResult = followupResult
          ? result + '\n\n' + followupResult
          : result;

        addToHistory(userId, 'assistant', finalResult);
        await safeSendMessage(bot, chatId, finalResult);

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
