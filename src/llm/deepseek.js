// src/llm/deepseek.js
// Handles all communication with DeepSeek API
require('dotenv').config();
const axios = require('axios');
const db = require('../db');

const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/v1/chat/completions';

function buildSystemPrompt(facts, timezone) {
  const factLines = facts.length
    ? facts.map(f => '- ' + f.key + ': ' + f.value).join('\n')
    : '(none yet)';

  const today = new Date().toISOString().split('T')[0];

  return 'You are Jarvis, a sharp and efficient personal AI assistant running on Telegram.\n' +
    'Current timezone: ' + timezone + '. Today is ' + today + '.\n\n' +
    'Personal facts about the user:\n' + factLines + '\n\n' +
    'AVAILABLE TOOLS:\n' +
    '- create_reminder: set a time-based reminder\n' +
    '- create_event: add a calendar event\n' +
    '- add_note: save a note or idea\n' +
    '- get_today: fetch today\'s schedule and reminders\n' +
    '- set_fact: store a personal preference or fact about the user\n\n' +
    'STRICT OUTPUT FORMAT - respond with ONLY valid JSON, nothing else:\n\n' +
    '1. Regular reply:\n' +
    '{"type":"message","content":"your reply here"}\n\n' +
    '2. Tool call:\n' +
    '{"type":"tool","name":"tool_name","args":{...}}\n\n' +
    'For times use ISO-8601: YYYY-MM-DDTHH:mm:ss\n' +
    'Convert relative times like "at 9pm" or "in 2 hours" to absolute datetime.\n\n' +
    'TOOL SCHEMAS:\n' +
    'create_reminder: { "text": string, "time": "ISO-8601" }\n' +
    'create_event: { "title": string, "time": "ISO-8601", "duration_minutes": number }\n' +
    'add_note: { "content": string }\n' +
    'get_today: {}\n' +
    'set_fact: { "key": string, "value": string }';
}

async function chat(userId, userMessage, conversationHistory) {
  if (!conversationHistory) conversationHistory = [];

  const facts = await db.getAllFacts(userId);
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
    return { type: 'message', content: rawText };
  }
}

module.exports = { chat };
