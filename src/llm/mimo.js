// src/llm/mimo.js
// Xiaomi MiMo API provider — OpenAI-compatible
require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const redisCache = require('../redis');
const memory = require('../memory');
const relationships = require('../memory/relationships');
const { buildSystemPrompt, normalizeLLMResponse } = require('./shared');
const validator = require('./validator');

const MIMO_BASE = (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
const MIMO_URL = MIMO_BASE.endsWith('/v1')
  ? MIMO_BASE + '/chat/completions'
  : MIMO_BASE + '/v1/chat/completions';

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

  // ── Try 1: strip markdown fences then parse ───────────────────────────
  try {
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    const normalized = normalizeLLMResponse(parsed);
    if (normalized) {
      // ✅ Validate cancel_reminder calls against actual reminders (always)
      if (normalized.type === 'tool' && normalized.name === 'cancel_reminder') {
        const cancelValidation = validator.validateCancelReminder(normalized, upcomingReminders, userMessage);
        if (!cancelValidation.isValid) {
          console.warn('[MiMo] ⛔️ Blocked invalid cancel_reminder:', cancelValidation.error);
          return {
            type: 'message',
            content: cancelValidation.suggestion || 'I couldn\'t find that reminder.',
          };
        }
      }

      // ⚡ Skip hallucination validator for fast-tier messages (greetings etc.)
      if (!minimal) {
        const validation = validator.validateLLMResponse(normalized, {
          timezone: process.env.TIMEZONE || 'UTC',
          userFacts: facts,
          upcomingReminders: upcomingReminders,
        });

        if (!validation.isValid && normalized.type === 'message') {
          console.warn('[MiMo] ⚠️ Hallucination detected:', validation.issues.join('; '));
          if (validation.forceToolCall) {
            console.log('[MiMo] 🔄 Forcing list_reminders tool call to get accurate times');
            return { type: 'tool', name: 'list_reminders', args: {} };
          }
          const fallback = validator.generateFallbackResponse(userMessage);
          return { type: 'message', content: fallback };
        }

        if (validation.issues.length > 0) {
          console.log('[MiMo] Validation issues (non-critical):', validation.issues.join('; '));
        }
      }

      console.log('[MiMo] Parsed OK (type=' + normalized.type + (normalized.name ? ', name=' + normalized.name : '') + ')');
      return normalized;
    }
    console.log('[MiMo] Valid JSON but unrecognized structure, falling back to rawText');
    return { type: 'message', content: rawText };
  } catch (e) {
    // ── Try 2: extract JSON object with regex ───────────────────────────
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[0]);
        const normalized = normalizeLLMResponse(extracted);
        if (normalized) {
          // ✅ Validate cancel_reminder calls against actual reminders (always)
          if (normalized.type === 'tool' && normalized.name === 'cancel_reminder') {
            const cancelValidation = validator.validateCancelReminder(normalized, upcomingReminders, userMessage);
            if (!cancelValidation.isValid) {
              console.warn('[MiMo] ⛔️ Blocked invalid cancel_reminder:', cancelValidation.error);
              return {
                type: 'message',
                content: cancelValidation.suggestion || 'I couldn\'t find that reminder.',
              };
            }
          }

          // ⚡ Skip hallucination validator for fast-tier messages
          if (!minimal) {
            const validation = validator.validateLLMResponse(normalized, {
              timezone: process.env.TIMEZONE || 'UTC',
              userFacts: facts,
              upcomingReminders: upcomingReminders,
            });

            if (!validation.isValid && normalized.type === 'message') {
              console.warn('[MiMo] ⚠️ Hallucination detected:', validation.issues.join('; '));
              if (validation.forceToolCall) {
                console.log('[MiMo] 🔄 Forcing list_reminders tool call to get accurate times');
                return { type: 'tool', name: 'list_reminders', args: {} };
              }
              const fallback = validator.generateFallbackResponse(userMessage);
              return { type: 'message', content: fallback };
            }

            if (validation.issues.length > 0) {
              console.log('[MiMo] Validation issues (non-critical):', validation.issues.join('; '));
            }
          }

          console.log('[MiMo] Regex-extracted JSON OK (type=' + normalized.type + (normalized.name ? ', name=' + normalized.name : '') + ')');
          return normalized;
        }
        console.log('[MiMo] Regex-extracted JSON but unrecognized structure');
      } catch (_) {
        console.log('[MiMo] Regex extraction found but JSON.parse failed');
      }
    } else {
      console.log('[MiMo] No JSON object found in response, treating as plain message');
    }
    return { type: 'message', content: rawText };
  }
}

/**
 * Streaming version — calls onChunk(displayText) progressively as tokens arrive.
 * Only extracts displayable content for message-type responses.
 * For tool calls, buffers silently and returns the parsed result.
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

  try {
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    const normalized = normalizeLLMResponse(parsed);
    if (normalized) {
      if (normalized.type === 'tool' && normalized.name === 'cancel_reminder') {
        const cancelValidation = validator.validateCancelReminder(normalized, upcomingReminders, userMessage);
        if (!cancelValidation.isValid) {
          return { type: 'message', content: cancelValidation.suggestion || "I couldn't find that reminder." };
        }
      }
      if (!minimal) {
        const validation = validator.validateLLMResponse(normalized, { timezone: process.env.TIMEZONE || 'UTC', userFacts: facts, upcomingReminders });
        if (!validation.isValid && normalized.type === 'message') {
          if (validation.forceToolCall) return { type: 'tool', name: 'list_reminders', args: {} };
          return { type: 'message', content: validator.generateFallbackResponse(userMessage) };
        }
      }
      return normalized;
    }
    return { type: 'message', content: rawText };
  } catch {
    return { type: 'message', content: rawText };
  }
}

module.exports = { chat, chatStream };
