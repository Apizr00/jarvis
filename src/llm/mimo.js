// src/llm/mimo.js
// Xiaomi MiMo API provider — OpenAI-compatible
require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const redisCache = require('../redis');
const memory = require('../memory');
const relationships = require('../memory/relationships');
const { buildSystemPrompt, parseAndValidate } = require('./shared');

const MIMO_BASE = (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
const MIMO_URL = MIMO_BASE.endsWith('/v1')
  ? MIMO_BASE + '/chat/completions'
  : MIMO_BASE + '/v1/chat/completions';

async function chat(userId, userMessage, conversationHistory, options = {}, prefetched = null) {
  if (!conversationHistory) conversationHistory = [];

  const executiveContext = options.executiveContext || '';

  // Reuse pre-fetched context from llm/index.js, or fetch directly.
  // All tiers now get the same data — no more minimal/skipping.
  let facts, upcomingReminders, peopleContext;
  if (prefetched) {
    ({ facts, upcomingReminders, peopleContext } = prefetched);
  } else {
    [facts, upcomingReminders, peopleContext] = await Promise.all([
      memory.searchFacts(userId, userMessage),
      db.getUpcomingReminders(userId, 15),
      relationships.getPeopleContext(userId, userMessage, 5),
    ]);
    memory.recordFactAccess(userId, facts.map(f => f.key));
  }

  const systemPrompt = await buildSystemPrompt(
    userId, facts, process.env.TIMEZONE || 'UTC', upcomingReminders, peopleContext,
    { tier: options.tier, executiveContext }
  );

  const messages = [
    { role: 'system', content: systemPrompt }
  ].concat(conversationHistory).concat([
    { role: 'user', content: userMessage }
  ]);

  let response;
  try {
    response = await axios.post(
      MIMO_URL,
      {
        model: process.env.MIMO_MODEL || 'mimo-v2.5-pro',
        messages: messages,
        max_tokens: options.maxTokens || 800,
        temperature: 0.3,
      },
      {
        headers: {
          'Authorization': 'Bearer ' + process.env.MIMO_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
  } catch (err) {
    if (err.response) {
      console.error('MiMo API error:', err.response.status, JSON.stringify(err.response.data).slice(0, 300));
    }
    throw err;
  }

  const rawText = response.data.choices[0].message.content.trim();
  console.log('[MiMo] Raw response:', rawText.slice(0, 300));

  return parseAndValidate(rawText, {
    upcomingReminders,
    userMessage,
    facts,
  });
}

/**
 * Streaming version — calls onChunk(displayText) progressively as tokens arrive.
 * Only extracts displayable content for message-type responses.
 * For tool calls, buffers silently and returns the parsed result.
 */
async function chatStream(userId, userMessage, conversationHistory, options = {}, prefetched = null, onChunk) {
  if (!conversationHistory) conversationHistory = [];
  if (typeof onChunk !== 'function') onChunk = () => { };

  const executiveContext = options.executiveContext || '';

  let facts, upcomingReminders, peopleContext;
  if (prefetched) {
    ({ facts, upcomingReminders, peopleContext } = prefetched);
  } else {
    [facts, upcomingReminders, peopleContext] = await Promise.all([
      memory.searchFacts(userId, userMessage),
      db.getUpcomingReminders(userId, 15),
      relationships.getPeopleContext(userId, userMessage, 5),
    ]);
    memory.recordFactAccess(userId, facts.map(f => f.key));
    memory.recordFactAccess(userId, facts.map(f => f.key));
  }

  const systemPrompt = await buildSystemPrompt(
    userId, facts, process.env.TIMEZONE || 'UTC', upcomingReminders, peopleContext,
    { tier: options.tier, executiveContext }
  );

  const messages = [
    { role: 'system', content: systemPrompt }
  ].concat(conversationHistory).concat([
    { role: 'user', content: userMessage }
  ]);

  const response = await axios.post(
    MIMO_URL,
    {
      model: process.env.MIMO_MODEL || 'mimo-v2.5-pro',
      messages: messages,
      max_tokens: options.maxTokens || 800,
      temperature: 0.3,
      stream: true,
    },
    {
      headers: {
        'Authorization': 'Bearer ' + process.env.MIMO_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      responseType: 'stream',
    }
  );

  let rawText = '';
  let isMessage = null;
  const MESSAGE_PREFIX = '{"type":"message","content":"';

  await new Promise((resolve, reject) => {
    let buffer = '';

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (!delta) continue;

          rawText += delta;

          if (isMessage === null && rawText.length > 10) {
            isMessage = rawText.trimStart().startsWith(MESSAGE_PREFIX);
          }

          if (isMessage === true && onChunk) {
            let display = rawText;
            display = display.replace(/^\s*\{"type":"message","content":"/, '');
            if (display.endsWith('"}') && rawText.endsWith('"}')) {
              display = display.slice(0, -2);
            }
            onChunk(display);
          }
        } catch { /* skip malformed SSE chunks */ }
      }
    });

    response.data.on('end', resolve);
    response.data.on('error', reject);
  });

  console.log('[MiMo] Stream complete (' + rawText.length + ' chars):', rawText.slice(0, 200));

  return parseAndValidate(rawText, {
    upcomingReminders,
    userMessage,
    facts,
  });
}

module.exports = { chat, chatStream };
