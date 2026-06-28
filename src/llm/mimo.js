// src/llm/mimo.js
// Xiaomi MiMo API provider — OpenAI-compatible
require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const redisCache = require('../redis');
const memory = require('../memory');
const { buildSystemPrompt, normalizeLLMResponse } = require('./shared');

const MIMO_BASE = (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
const MIMO_URL = MIMO_BASE.endsWith('/v1')
  ? MIMO_BASE + '/chat/completions'
  : MIMO_BASE + '/v1/chat/completions';

async function chat(userId, userMessage, conversationHistory) {
  if (!conversationHistory) conversationHistory = [];

  // 🔍 Semantic search: only retrieve facts relevant to user's current message
  let facts = await memory.searchFacts(userId, userMessage);

  // Record that these facts were accessed (for importance scoring)
  memory.recordFactAccess(userId, facts.map(f => f.key));

  // Fetch upcoming reminders so the LLM can reference them by ID for update/cancel
  const upcomingReminders = await db.getUpcomingReminders(userId, 15);

  const systemPrompt = await buildSystemPrompt(userId, facts, process.env.TIMEZONE || 'UTC', upcomingReminders);

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
        max_tokens: 800,
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

module.exports = { chat };
