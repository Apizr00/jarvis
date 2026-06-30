// src/llm/deepseek.js
// DeepSeek API provider
require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const redisCache = require('../redis');
const memory = require('../memory');
const relationships = require('../memory/relationships');
const { buildSystemPrompt, parseAndValidate } = require('./shared');

const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/v1/chat/completions';

async function chat(userId, userMessage, conversationHistory, options = {}, prefetched = null) {
  if (!conversationHistory) conversationHistory = [];

  const minimal = options.minimal === true;
  const executiveContext = options.executiveContext || '';

  // Reuse pre-fetched context from llm/index.js, or fetch in parallel
  let facts, upcomingReminders, peopleContext;
  if (prefetched) {
    ({ facts, upcomingReminders, peopleContext } = prefetched);
  } else if (!minimal) {
    [facts, upcomingReminders, peopleContext] = await Promise.all([
      memory.searchFacts(userId, userMessage),
      db.getUpcomingReminders(userId, 15),
      relationships.getPeopleContext(userId, userMessage, 5),
    ]);
    memory.recordFactAccess(userId, facts.map(f => f.key));
  } else {
    facts = [];
    upcomingReminders = [];
    peopleContext = '';
  }

  const systemPrompt = await buildSystemPrompt(
    userId, facts, process.env.TIMEZONE || 'UTC', upcomingReminders, peopleContext,
    { minimal, executiveContext }
  );

  const messages = [
    { role: 'system', content: systemPrompt }
  ].concat(conversationHistory).concat([
    { role: 'user', content: userMessage }
  ]);

  const response = await axios.post(
    DEEPSEEK_URL,
    {
      model: 'deepseek-chat',
      messages: messages,
      max_tokens: options.maxTokens || 800,
      temperature: 0.3,
    },
    {
      headers: {
        'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  const rawText = response.data.choices[0].message.content.trim();
  console.log('[DeepSeek] Raw response:', rawText.slice(0, 300));

  return parseAndValidate(rawText, {
    minimal,
    upcomingReminders,
    userMessage,
    facts,
  });
}

/**
 * Streaming version — calls onChunk(displayText) progressively as tokens arrive.
 * Only extracts displayable content for message-type responses.
 * For tool calls, buffers silently and returns the parsed result.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {Array} conversationHistory
 * @param {object} options
 * @param {object|null} prefetched
 * @param {function} onChunk - callback(displayText) for each accumulation
 * @returns {Promise<{type:string, content?:string, name?:string, args?:object}>}
 */
async function chatStream(userId, userMessage, conversationHistory, options = {}, prefetched = null, onChunk) {
  if (!conversationHistory) conversationHistory = [];
  if (typeof onChunk !== 'function') onChunk = () => { };

  const minimal = options.minimal === true;
  const executiveContext = options.executiveContext || '';

  let facts, upcomingReminders, peopleContext;
  if (prefetched) {
    ({ facts, upcomingReminders, peopleContext } = prefetched);
  } else if (!minimal) {
    [facts, upcomingReminders, peopleContext] = await Promise.all([
      memory.searchFacts(userId, userMessage),
      db.getUpcomingReminders(userId, 15),
      relationships.getPeopleContext(userId, userMessage, 5),
    ]);
    memory.recordFactAccess(userId, facts.map(f => f.key));
  } else {
    facts = [];
    upcomingReminders = [];
    peopleContext = '';
  }

  const systemPrompt = await buildSystemPrompt(
    userId, facts, process.env.TIMEZONE || 'UTC', upcomingReminders, peopleContext,
    { minimal, executiveContext }
  );

  const messages = [
    { role: 'system', content: systemPrompt }
  ].concat(conversationHistory).concat([
    { role: 'user', content: userMessage }
  ]);

  // ── Streaming request to DeepSeek ──────────────────────────────────────
  const response = await axios.post(
    DEEPSEEK_URL,
    {
      model: 'deepseek-chat',
      messages: messages,
      max_tokens: options.maxTokens || 800,
      temperature: 0.3,
      stream: true,
    },
    {
      headers: {
        'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      responseType: 'stream',
    }
  );

  // ── Parse SSE stream ───────────────────────────────────────────────────
  let rawText = '';
  let isMessage = null; // null=unknown, true=message, false=tool
  const MESSAGE_PREFIX = '{"type":"message","content":"';

  await new Promise((resolve, reject) => {
    let buffer = '';

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

        try {
          const json = JSON.parse(line.slice(6)); // strip "data: " prefix
          const delta = json.choices?.[0]?.delta?.content;
          if (!delta) continue;

          rawText += delta;

          // Detect message vs tool on first meaningful tokens
          if (isMessage === null && rawText.length > 10) {
            isMessage = rawText.trimStart().startsWith(MESSAGE_PREFIX);
          }

          // 🔥 Show streaming text for message-type responses
          if (isMessage === true && onChunk) {
            let display = rawText;
            // Strip JSON wrapper to show just the content
            display = display.replace(/^\s*\{"type":"message","content":"/, '');
            // Don't strip trailing quotes until complete (they may be partial)
            if (display.endsWith('"}') && rawText.endsWith('"}')) {
              display = display.slice(0, -2);
            }
            onChunk(display);
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    });

    response.data.on('end', resolve);
    response.data.on('error', reject);
  });

  console.log('[DeepSeek] Stream complete (' + rawText.length + ' chars):', rawText.slice(0, 200));

  return parseAndValidate(rawText, {
    minimal,
    upcomingReminders,
    userMessage,
    facts,
  });
}

module.exports = { chat, chatStream };
