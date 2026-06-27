// src/llm/mimo.js
// Xiaomi MiMo API provider — OpenAI-compatible
require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const redisCache = require('../redis');
const { buildSystemPrompt } = require('./shared');

const MIMO_BASE = (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
const MIMO_URL = MIMO_BASE.endsWith('/v1')
  ? MIMO_BASE + '/chat/completions'
  : MIMO_BASE + '/v1/chat/completions';

async function chat(userId, userMessage, conversationHistory) {
  if (!conversationHistory) conversationHistory = [];

  // Try Redis cache first, fall back to DB
  let facts = await redisCache.getFactsCache(userId);
  if (facts === null) {
    facts = await db.getAllFacts(userId);
    redisCache.setFactsCache(userId, facts);
  }

  const systemPrompt = buildSystemPrompt(facts, process.env.TIMEZONE || 'UTC');

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
        max_tokens: 500,
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

  try {
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.type === 'message' || parsed.type === 'tool') {
      return parsed;
    }
    return { type: 'message', content: rawText };
  } catch (e) {
    // JSON.parse failed on full text — try to extract just the JSON object
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[0]);
        if (extracted.type === 'message' || extracted.type === 'tool') {
          return extracted;
        }
      } catch (_) { /* still couldn't parse, fall through */ }
    }
    return { type: 'message', content: rawText };
  }
}

module.exports = { chat };
