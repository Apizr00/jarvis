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

async function chat(userId, userMessage, conversationHistory, options = {}) {
  if (!conversationHistory) conversationHistory = [];

  const minimal = options.minimal === true;
  const executiveContext = options.executiveContext || '';

  // 🔍 Semantic search (skip if minimal mode)
  let facts = [];
  if (!minimal) {
    facts = await memory.searchFacts(userId, userMessage);
    // Record that these facts were accessed (for importance scoring)
    memory.recordFactAccess(userId, facts.map(f => f.key));
  }

  // Fetch upcoming reminders (skip if minimal mode)
  const upcomingReminders = minimal ? [] : await db.getUpcomingReminders(userId, 15);

  // 👥 Get relevant people context (skip if minimal mode)
  const peopleContext = minimal ? '' : await relationships.getPeopleContext(userId, userMessage, 5);

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
      max_tokens: 800,
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
      // ✅ Validate cancel_reminder calls against actual reminders
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

      // ✅ Validate the response for hallucinations
      const validation = validator.validateLLMResponse(normalized, {
        timezone: process.env.TIMEZONE || 'UTC',
        userFacts: facts,
        upcomingReminders: upcomingReminders,
      });

      if (!validation.isValid && normalized.type === 'message') {
        console.warn('[DeepSeek] ⚠️ Hallucination detected:', validation.issues.join('; '));
        // If reminder fabrication, force list_reminders tool call instead of fallback message
        if (validation.forceToolCall) {
          console.log('[DeepSeek] 🔄 Forcing list_reminders tool call to get accurate times');
          return { type: 'tool', name: 'list_reminders', args: {} };
        }
        // Override with a safe clarifying question
        const fallback = validator.generateFallbackResponse(userMessage);
        return { type: 'message', content: fallback };
      }

      if (validation.issues.length > 0) {
        console.log('[DeepSeek] Validation issues (non-critical):', validation.issues.join('; '));
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
          // ✅ Validate cancel_reminder calls against actual reminders
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

          // ✅ Validate the response
          const validation = validator.validateLLMResponse(normalized, {
            timezone: process.env.TIMEZONE || 'UTC',
            userFacts: facts,
            upcomingReminders: upcomingReminders,
          });

          if (!validation.isValid && normalized.type === 'message') {
            console.warn('[DeepSeek] ⚠️ Hallucination detected:', validation.issues.join('; '));
            // If reminder fabrication, force list_reminders tool call
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

module.exports = { chat };
