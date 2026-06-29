// src/llm/deepseek.js
// DeepSeek API provider
require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const redisCache = require('../redis');
const memory = require('../memory');
const relationships = require('../memory/relationships');
const { buildSystemPrompt, normalizeLLMResponse } = require('./shared');

const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/v1/chat/completions';

async function chat(userId, userMessage, conversationHistory) {
  if (!conversationHistory) conversationHistory = [];

  // 🔍 Semantic search: only retrieve facts relevant to user's current message
  let facts = await memory.searchFacts(userId, userMessage);

  // Record that these facts were accessed (for importance scoring)
  memory.recordFactAccess(userId, facts.map(f => f.key));

  // Fetch upcoming reminders so the LLM can reference them by ID for update/cancel
  const upcomingReminders = await db.getUpcomingReminders(userId, 15);

  // 👥 Get relevant people context
  const peopleContext = await relationships.getPeopleContext(userId, userMessage, 5);

  const systemPrompt = await buildSystemPrompt(userId, facts, process.env.TIMEZONE || 'UTC', upcomingReminders, peopleContext);

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
