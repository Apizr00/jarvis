// src/llm/deepseek.js
// DeepSeek API provider
require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const redisCache = require('../redis');
const memory = require('../memory');
const relationships = require('../memory/relationships');
const { buildSystemPrompt, normalizeLLMResponse } = require('./shared');
const validator = require('./validator');

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
          console.warn('[DeepSeek] ⛔️ Blocked invalid cancel_reminder:', cancelValidation.error);
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
          console.warn('[DeepSeek] ⚠️ Hallucination detected:', validation.issues.join('; '));
          if (validation.forceToolCall) {
            console.log('[DeepSeek] 🔄 Forcing list_reminders tool call to get accurate times');
            return { type: 'tool', name: 'list_reminders', args: {} };
          }
          const fallback = validator.generateFallbackResponse(userMessage);
          return { type: 'message', content: fallback };
        }

        if (validation.issues.length > 0) {
          console.log('[DeepSeek] Validation issues (non-critical):', validation.issues.join('; '));
        }
      }

      console.log('[DeepSeek] Parsed OK (type=' + normalized.type + (normalized.name ? ', name=' + normalized.name : '') + ')');
      return normalized;
    }
    // Valid JSON but unrecognized structure — fall through to rawText
    console.log('[DeepSeek] Valid JSON but unrecognized structure, falling back to rawText');
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
              console.warn('[DeepSeek] ⛔️ Blocked invalid cancel_reminder:', cancelValidation.error);
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
              console.warn('[DeepSeek] ⚠️ Hallucination detected:', validation.issues.join('; '));
              if (validation.forceToolCall) {
                console.log('[DeepSeek] 🔄 Forcing list_reminders tool call to get accurate times');
                return { type: 'tool', name: 'list_reminders', args: {} };
              }
              const fallback = validator.generateFallbackResponse(userMessage);
              return { type: 'message', content: fallback };
            }

            if (validation.issues.length > 0) {
              console.log('[DeepSeek] Validation issues (non-critical):', validation.issues.join('; '));
            }
          }

          console.log('[DeepSeek] Regex-extracted JSON OK (type=' + normalized.type + (normalized.name ? ', name=' + normalized.name : '') + ')');
          return normalized;
        }
        console.log('[DeepSeek] Regex-extracted JSON but unrecognized structure');
      } catch (_) {
        console.log('[DeepSeek] Regex extraction found but JSON.parse failed');
      }
    } else {
      console.log('[DeepSeek] No JSON object found in response, treating as plain message');
    }
    return { type: 'message', content: rawText };
  }
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

  // ── Parse final response (same logic as chat()) ────────────────────────
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
