// src/memory/relationships.js
// ── Relationship Memory ──────────────────────────────────────────────────────
// Dedicated system for remembering people the user mentions.
// Auto-extracts names, relationships, and context from conversations.
// Unlike facts (which are about the USER), this is about OTHERS.
//
// Schema: { name, relationship, context, notes, confidence, mention_count, ... }

const db = require('../db');
const redisCache = require('../redis');

// ── 1. Auto-Extract People from Chat ────────────────────────────────────────

/**
 * Extract people/relationships mentioned in a conversation.
 * Called asynchronously (fire-and-forget) after each exchange.
 *
 * @param {string} userId
 * @param {string} userMessage - what the user said
 * @param {string} assistantResponse - what the bot replied
 * @param {object} llmChatFn - the LLM chat function
 */
async function extractPeopleFromChat(userId, userMessage, assistantResponse, llmChatFn) {
  try {
    const extractionPrompt =
      '👥 PEOPLE EXTRACTION TASK\n\n' +
      'You are analyzing a conversation between a user and their AI assistant.\n' +
      'Your job: extract any PEOPLE the user mentions.\n\n' +
      '─────────────── CONVERSATION ───────────────\n' +
      'User: ' + userMessage + '\n\n' +
      'Assistant: ' + assistantResponse + '\n' +
      '──────────────────────────────────────────────\n\n' +
      'RULES:\n' +
      '1. Extract ANY person the user mentions: family, friends, colleagues, bosses, neighbors, anyone.\n' +
      '2. For each person, provide:\n' +
      '   - "name": the person\'s name (or title like "mum", "boss" if name unknown)\n' +
      '   - "relationship": how they relate to user ("friend", "colleague", "family", "wife", "boss", "mentor", etc.)\n' +
      '   - "context": brief 1-sentence summary of what was said about them\n' +
      '   - "confidence": 0.0-1.0 (how sure you are this is a real person and the relationship is correct)\n' +
      '3. If NO people are mentioned → return {"people":[]}\n' +
      '4. Do NOT extract the assistant (Jarvis/Bot) or the user themselves.\n' +
      '5. If a person is mentioned again with NEW info → still extract them (system will merge).\n\n' +
      'Examples:\n' +
      '• "My wife Sarah is a doctor" → {"people":[{"name":"Sarah","relationship":"wife","context":"Sarah is the user\'s wife, she is a doctor","confidence":0.9}]}\n' +
      '• "I have meeting with Ali tomorrow" → {"people":[{"name":"Ali","relationship":"colleague","context":"User has a meeting with Ali","confidence":0.7}]}\n' +
      '• "Call mum later" → {"people":[{"name":"mum","relationship":"family","context":"User needs to call their mother","confidence":0.85}]}\n' +
      '• "My boss Azman wants the report" → {"people":[{"name":"Azman","relationship":"boss","context":"User\'s boss, Azman, wants a report","confidence":0.9}]}\n' +
      '• "What time is it?" → {"people":[]}\n\n' +
      'Respond with ONLY a JSON object. No markdown, no explanation.\n' +
      'Format: {"people":[{"name":"...","relationship":"...","context":"...","confidence":0.9}]}';

    const extractHistory = [{ role: 'user', content: extractionPrompt }];

    // ⏱️ Timeout guard: extraction is fire-and-forget, don't let it hang
    const EXTRACTION_TIMEOUT_MS = 10000;
    const llmResponse = await Promise.race([
      llmChatFn(userId, extractionPrompt, extractHistory),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('People extraction timed out after ' + EXTRACTION_TIMEOUT_MS / 1000 + 's')), EXTRACTION_TIMEOUT_MS)
      ),
    ]);

    let rawText = '';
    if (llmResponse.type === 'message') {
      rawText = llmResponse.content;
    } else {
      return; // unexpected response type
    }

    // Parse JSON
    let parsed;
    try {
      const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(cleaned);
    } catch {
      console.log('[Relationships] Could not parse people extraction response, skipping');
      return;
    }

    const people = parsed.people || [];
    if (!Array.isArray(people) || people.length === 0) return;

    // ── Save each person ─────────────────────────────────────────────────
    for (const person of people) {
      if (!person.name) continue;

      const name = normalizeName(person.name);
      if (isStopName(name)) continue; // filter out generic non-people terms

      await db.upsertRelationship(userId, {
        name,
        relationship: person.relationship || '',
        context: person.context || '',
        notes: person.notes || '',
        confidence: typeof person.confidence === 'number' ? person.confidence : 0.7,
      });

      console.log('[Relationships] 👤 Saved person: ' + name +
        (person.relationship ? ' (' + person.relationship + ')' : ''));
    }

    if (people.length > 0) {
      console.log('[Relationships] ✅ Extracted ' + people.length + ' person(s) from conversation');
    }
  } catch (err) {
    console.warn('[Relationships] People extraction failed (non-fatal):', err.message);
  }
}

// ── 2. Search & Retrieve ─────────────────────────────────────────────────────

/**
 * Search for people relevant to a user's query.
 * Uses case-insensitive name matching.
 *
 * @param {string} userId
 * @param {string} query - what the user is asking
 * @param {number} [limit=5]
 * @returns {Promise<Array>}
 */
async function searchPeople(userId, query, limit = 5) {
  // Try exact name match first
  const queryLower = query.toLowerCase();

  // Get all relationships
  const allPeople = await db.getRelationships(userId, 100);

  if (allPeople.length === 0) return [];

  // Score each person by relevance to query
  const scored = allPeople.map(person => {
    let score = 0;
    const name = person.name.toLowerCase();
    const rel = (person.relationship || '').toLowerCase();
    const ctx = (person.context || '').toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);

    for (const word of queryWords) {
      if (name === word) score += 10;                    // exact name match
      else if (name.includes(word)) score += 5;          // name contains word
      else if (word.includes(name)) score += 8;          // query contains name
      else if (rel.includes(word)) score += 3;           // relationship match
      else if (ctx.includes(word)) score += 1;           // context match
    }

    // Boost by recency and mention frequency
    score += Math.log(person.mention_count + 1) * 0.5;
    score += (person.confidence || 0.5) * 2;

    return { ...person, _score: score };
  });

  // Sort by score, take top N
  scored.sort((a, b) => b._score - a._score);
  return scored.filter(p => p._score > 0).slice(0, limit).map(({ _score, ...p }) => p);
}

/**
 * Format people into a human-readable message for the bot.
 * @param {Array} people
 * @param {string} [title] - optional custom title
 * @returns {string}
 */
function formatPeopleMessage(people, title) {
  if (!people || people.length === 0) {
    return '👥 *No people remembered yet.*\n\nWhen you mention people in conversation, I\'ll automatically remember them. Try saying something like "My wife Sarah is a doctor" or "I work with Ali".';
  }

  let msg = title
    ? '*👥 ' + title + ' (' + people.length + ')*\n\n'
    : '*👥 People You Know (' + people.length + ')*\n\n';

  people.forEach((p, i) => {
    const relationEmoji = getRelationEmoji(p.relationship);
    const relationLabel = p.relationship
      ? ' _(' + p.relationship.charAt(0).toUpperCase() + p.relationship.slice(1) + ')_'
      : '';
    const mentionInfo = p.mention_count > 1
      ? ' — mentioned ' + p.mention_count + '×'
      : '';

    msg += '*' + (i + 1) + '. ' + escapeMd(p.name) + '*' + relationLabel + '\n';

    if (p.context) {
      msg += '   ' + escapeMd(p.context.length > 100 ? p.context.slice(0, 100) + '…' : p.context) + '\n';
    }

    const confBar = '█'.repeat(Math.round(p.confidence * 5)) + '░'.repeat(5 - Math.round(p.confidence * 5));
    msg += '   `' + confBar + '` ' + Math.round(p.confidence * 100) + '%' + mentionInfo + '\n\n';
  });

  return msg.trim();
}

// ── 3. Build Context for System Prompt ───────────────────────────────────────

/**
 * Get a concise summary of people relevant to a user's query
 * to inject into the system prompt so the LLM can reference them.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {number} [maxPeople=5]
 * @returns {Promise<string>} formatted context lines
 */
async function getPeopleContext(userId, userMessage, maxPeople = 5) {
  const relevant = await searchPeople(userId, userMessage, maxPeople);
  if (relevant.length === 0) return '';

  return '─────────────── 👥 PEOPLE YOU KNOW ───────────────\n' +
    relevant.map(p => {
      let line = '- ' + p.name;
      if (p.relationship) line += ' [' + p.relationship + ']';
      if (p.context) line += ': ' + p.context;
      return line;
    }).join('\n') + '\n\n';
}

// ── 4. Utility ────────────────────────────────────────────────────────────────

/**
 * Normalize a person's name: trim, title case.
 */
function normalizeName(name) {
  return name.trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Filter out names that are too generic to be real people.
 */
function isStopName(name) {
  const stopNames = [
    'someone', 'somebody', 'anyone', 'anybody', 'everyone', 'nobody',
    'people', 'person', 'guy', 'girl', 'man', 'woman', 'dude', 'buddy',
    'bro', 'sis', 'sir', 'madam', 'mr', 'mrs', 'ms', 'dr',
    'the', 'a', 'an', 'this', 'that', 'it', 'he', 'she', 'they', 'them',
    'user', 'pengguna', 'boss', 'client', 'klien', 'customer', 'pelanggan',
  ];
  return stopNames.includes(name.toLowerCase());
}

/**
 * Get emoji for relationship type.
 */
function getRelationEmoji(relationship) {
  const map = {
    'wife': '💍', 'husband': '💍', 'spouse': '💍', 'partner': '💑',
    'mum': '👩', 'mother': '👩', 'dad': '👨', 'father': '👨', 'parent': '👪',
    'brother': '👦', 'sister': '👧', 'sibling': '👫',
    'son': '🧒', 'daughter': '👧', 'child': '👶',
    'family': '👪', 'grandma': '👵', 'grandpa': '👴',
    'friend': '🤝', 'best friend': '🌟',
    'colleague': '💼', 'coworker': '💼', 'boss': '👔', 'manager': '👔',
    'employee': '🧑‍💼', 'client': '🤝', 'team': '👥',
    'mentor': '🧑‍🏫', 'teacher': '🧑‍🏫', 'student': '🎓',
    'neighbor': '🏠', 'doctor': '🩺', 'coach': '🏋️',
  };
  return map[relationship.toLowerCase()] || '👤';
}

/**
 * Escape special characters for Telegram Markdown.
 * (Minimal inline version to avoid circular requires.)
 */
function escapeMd(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/([_*`\[])/g, '\\$1');
}

module.exports = {
  extractPeopleFromChat,
  searchPeople,
  formatPeopleMessage,
  getPeopleContext,
};
