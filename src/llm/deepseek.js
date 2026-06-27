// src/llm/deepseek.js
// DeepSeek API provider
require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const redisCache = require('../redis');
const { buildSystemPrompt } = require('./shared');

const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/v1/chat/completions';

async function chat(userId, userMessage, conversationHistory) {
  if (!conversationHistory) conversationHistory = [];

  // Try Redis cache first, fall back to DB
  let facts = await redisCache.getFactsCache(userId);
  if (facts === null) {
    facts = await db.getAllFacts(userId);
    // Populate cache for next time (fire-and-forget)
    redisCache.setFactsCache(userId, facts);
  }

  const systemPrompt = buildSystemPrompt(facts, process.env.TIMEZONE || 'UTC');

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
      max_tokens: 500,
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
