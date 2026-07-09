// src/memory/index.js
// Memory Retrieval & Management — Semantic search (RAG), auto-extract, importance scoring
const db = require('../db');
const redisCache = require('../redis');

// ── 1. Semantic Memory Search (RAG) ──────────────────────────────────────────

/**
 * Score how relevant a fact is to a user query.
 * Uses hybrid approach: keyword matching + time-context awareness + semantic similarity.
 * @param {string} query - user's message
 * @param {{key:string, value:string, confidence?:number, importance?:number}} fact
 * @returns {number} relevance score (higher = more relevant)
 */
function scoreFactRelevance(query, fact) {
  const q = query.toLowerCase();
  const k = fact.key.toLowerCase();
  const v = fact.value.toLowerCase();
  let score = 0;

  // Split query into individual words (filter out very short words and common stop words)
  const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'is', 'are', 'was', 'were', 'yang', 'dan', 'di', 'ke', 'dari'];
  const queryWords = q.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));

  // Calculate word overlap scores
  let keyExactMatches = 0;
  let valueExactMatches = 0;
  let partialMatches = 0;

  for (const word of queryWords) {
    // Exact word match in key → strongest signal
    if (k.split(/[\s_-]/).includes(word)) {
      score += 5;
      keyExactMatches++;
    } else if (k.includes(word)) {
      // Partial match in key (e.g. "sleep" matches "sleeping")
      score += 3;
      partialMatches++;
    }

    // Exact word match in value → strong signal
    if (v.split(/[\s_-]/).includes(word)) {
      score += 3;
      valueExactMatches++;
    } else if (v.includes(word)) {
      // Partial match in value
      score += 1.5;
      partialMatches++;
    }
  }

  // Boost if multiple words match (indicates high relevance)
  if (keyExactMatches + valueExactMatches >= 2) {
    score += 5;
  }

  // Check for semantic category matches (enhanced with synonym mapping)
  const semanticMap = {
    // Time/routine
    sleep: ['tidur', 'bangun', 'wake', 'bedtime', 'nap', 'rest', 'rehat'],
    work: ['kerja', 'job', 'office', 'pejabat', 'task', 'tugasan', 'project', 'projek', 'meeting', 'mesyuarat'],
    food: ['makan', 'eat', 'food', 'diet', 'restaurant', 'kedai', 'lunch', 'dinner', 'breakfast', 'cook', 'masak'],
    exercise: ['gym', 'workout', 'senaman', 'run', 'lari', 'jogging', 'fitness', 'sports', 'sukan', 'yoga'],
    learning: ['study', 'belajar', 'course', 'kursus', 'book', 'buku', 'read', 'baca', 'learn', 'code', 'coding', 'tutorial'],
    travel: ['travel', 'jalan', 'cuti', 'holiday', 'vacation', 'trip', 'flight', 'hotel'],
    finance: ['money', 'duit', 'ringgit', 'rm', 'bank', 'saving', 'invest', 'labur', 'budget', 'bajet'],
    health: ['health', 'sihat', 'doctor', 'doktor', 'hospital', 'medicine', 'ubat', 'sick', 'sakit'],
    family: ['family', 'keluarga', 'wife', 'isteri', 'husband', 'suami', 'anak', 'child', 'parent', 'ibu', 'ayah'],
    prayer: ['solat', 'pray', 'subuh', 'zohor', 'asar', 'maghrib', 'isya', 'azan', 'doa', 'agama', 'islam'],
    home: ['rumah', 'house', 'home', 'pindah', 'move', 'renovate', 'renovasi', 'sewa', 'rent'],
    car: ['kereta', 'car', 'drive', 'pandu', 'motor', 'vehicle', 'kenderaan'],
    phone: ['phone', 'telefon', 'hp', 'mobile', 'device', 'gadget', 'laptop', 'computer'],
  };

  // Check if query matches any semantic domain and fact belongs to same domain
  for (const [domain, synonyms] of Object.entries(semanticMap)) {
    const queryInDomain = synonyms.some(s => q.includes(s));
    if (!queryInDomain) continue;
    const factInDomain = synonyms.some(s => k.includes(s) || v.includes(s));
    if (factInDomain) {
      score += 6; // Stronger boost for semantic matches
      break;
    }
  }

  // Legacy category matching (fallback)
  const categories = {
    schedule: ['pukul', 'jam', 'masa', 'time', 'when', 'bila', 'schedule', 'jadual', 'routine', 'rutin'],
    work: ['kerja', 'work', 'job', 'office', 'pejabat', 'meeting', 'mesyuarat', 'task', 'tugasan'],
    personal: ['suka', 'like', 'love', 'hate', 'prefer', 'favorite', 'kegemaran', 'hobby', 'hobi'],
    location: ['where', 'mana', 'location', 'place', 'tempat', 'live', 'duduk', 'tinggal', 'address'],
    people: ['who', 'siapa', 'friend', 'kawan', 'family', 'keluarga', 'name', 'nama'],
    health: ['health', 'kesihatan', 'exercise', 'senaman', 'sleep', 'tidur', 'diet', 'makan'],
  };

  for (const [category, keywords] of Object.entries(categories)) {
    const queryInCategory = keywords.some(kw => q.includes(kw));
    const factInCategory = keywords.some(kw => k.includes(kw) || v.includes(kw));

    if (queryInCategory && factInCategory) {
      score += 4;
      break; // Only boost once for category match
    }
  }

  // Time-related queries → boost facts likely about schedule/routine
  const timeWords = ['pukul', 'jam', 'masa', 'time', 'hari', 'day', 'minggu', 'week',
    'bulan', 'month', 'tahun', 'year', 'pagi', 'morning', 'malam', 'night',
    'tidur', 'sleep', 'bangun', 'wake', 'kerja', 'work', 'jadual', 'schedule',
    'rutin', 'routine', 'selalu', 'always', 'biasa', 'usually', 'setiap', 'every',
    'daily', 'weekly', 'monthly'];

  const isTimeQuery = timeWords.some(tw => q.includes(tw));
  if (isTimeQuery) {
    // Boost facts that contain numbers (likely times/dates)
    if (/\d/.test(v)) {
      score += 2;
    }
    // Boost facts with time-related keys
    if (timeWords.some(tw => k.includes(tw))) {
      score += 3;
    }
  }

  // Boost recently updated/accessed facts (recency bias)
  // Higher importance = user referenced it more → should be more relevant
  if (fact.importance && fact.importance > 5) {
    score += Math.min(fact.importance / 10, 3); // Cap at +3
  }

  // Boost high-confidence facts (user explicitly set them)
  if (fact.confidence && fact.confidence >= 0.9) {
    score += 2;
  }

  // Question detection - if user is asking a question, prioritize facts that might answer it
  const isQuestion = /\?|what|who|when|where|why|how|apa|siapa|bila|mana|kenapa|macam mana/i.test(q);
  if (isQuestion && (keyExactMatches > 0 || valueExactMatches > 0)) {
    score += 3;
  }

  return score;
}

/**
 * Search for facts relevant to a user's query.
 * Returns only the most relevant facts to keep the system prompt lean.
 *
 * @param {string} userId
 * @param {string} userMessage - the user's current message
 * @param {number} [maxFacts=8] - maximum facts to return
 * @returns {Promise<Array<{key:string, value:string}>>}
 */
async function searchFacts(userId, userMessage, maxFacts = 8) {
  // Try Redis cache first
  let allFacts = await redisCache.getFactsCache(userId);
  if (allFacts === null) {
    allFacts = await db.getAllFacts(userId);
    // Populate cache (fire-and-forget)
    redisCache.setFactsCache(userId, allFacts);
  }

  // If few facts, return all — no need to filter
  if (allFacts.length <= maxFacts) {
    return allFacts;
  }

  // Score and rank each fact
  const scored = allFacts.map(fact => ({
    ...fact,
    _score: scoreFactRelevance(userMessage, fact) + (fact.confidence || 0.7) * 2,
  }));

  // Sort by score descending, then take top N
  scored.sort((a, b) => b._score - a._score);

  // Always include facts that scored > 0, up to maxFacts
  const relevant = scored.filter(f => f._score > 0).slice(0, maxFacts);

  // If nothing scored > 0 (no keyword match), return a diverse sample:
  // take the first few facts from different "categories" based on keys
  if (relevant.length === 0) {
    const seen = new Set();
    const diverse = [];
    for (const f of scored) {
      const category = f.key.split('_')[0]; // e.g. "work" from "work_schedule"
      if (!seen.has(category) || diverse.length < 3) {
        seen.add(category);
        diverse.push(f);
      }
      if (diverse.length >= maxFacts) break;
    }
    return diverse.map(({ _score, ...fact }) => fact);
  }

  // Strip internal _score before returning
  return relevant.map(({ _score, ...fact }) => fact);
}

// ── 2. Auto-Extract Facts ───────────────────────────────────────────────────

/**
 * After each chat exchange, extract any new facts about the user from the conversation.
 * This is called asynchronously (fire-and-forget) after the main response is sent.
 *
 * @param {string} userId
 * @param {string} userMessage - what the user said
 * @param {string} assistantResponse - what the bot replied
 * @param {object} llmChatFn - the LLM chat function (e.g. llm.chat)
 */
async function extractFactsFromChat(userId, userMessage, assistantResponse, llmChatFn) {
  try {
    const extractionPrompt =
      '🔍 FACT EXTRACTION TASK\n\n' +
      'You are analyzing a conversation between a user and their AI assistant.\n' +
      'Your job: extract any NEW or UPDATED facts about the user.\n\n' +
      '─────────────── CONVERSATION ───────────────\n' +
      'User: ' + userMessage + '\n\n' +
      'Assistant: ' + assistantResponse + '\n' +
      '──────────────────────────────────────────────\n\n' +
      'RULES:\n' +
      '1. Only extract PERSONAL facts about the USER (preferences, habits, schedule, life events, relationships, goals, etc.)\n' +
      '2. Do NOT extract facts about the assistant, reminders, events, or notes.\n' +
      '3. If the user CORRECTED or UPDATED previous info, extract the NEW value.\n' +
      '4. If no new facts → return {"facts":[]}\n' +
      '5. Each fact must have a short descriptive "key" (snake_case, max 5 words), a concise "value", and a "confidence" (0.0-1.0).\n' +
      '6. Replace "I" / "saya" / "aku" with "User" / "Pengguna" in values for clarity.\n' +
      '7. Confidence guide:\n' +
      '   - Direct explicit statement ("I live in KL") → 0.9\n' +
      '   - Implied or inferred ("I think I might...") → 0.6\n' +
      '   - Correction of previous info ("Actually, I moved to...") → 0.85\n' +
      '   - Casual mention ("Oh btw I\'m...") → 0.75\n\n' +
      'Examples:\n' +
      '• User: "Saya tinggal di KL" → {"facts":[{"key":"location","value":"Kuala Lumpur","confidence":0.9}]}\n' +
      '• User: "I sleep at 2am every night" → {"facts":[{"key":"sleep_time","value":"2:00 AM","confidence":0.9}]}\n' +
      '• User: "My wife name is Sarah" → {"facts":[{"key":"wife_name","value":"Sarah","confidence":0.9}]}\n' +
      '• User: "I think I prefer dark mode" → {"facts":[{"key":"prefers_dark_mode","value":"true","confidence":0.6}]}\n' +
      '• User: "Saya vegetarian sekarang" → {"facts":[{"key":"diet","value":"vegetarian","confidence":0.85}]}\n' +
      '• User: "Remind me to call mum" → {"facts":[]}  (this is a task, not a fact)\n' +
      '• User: "What time is it?" → {"facts":[]}  (no personal info shared)\n\n' +
      'Respond with ONLY a JSON object. No markdown, no explanation.\n' +
      'Format: {"facts":[{"key":"...","value":"...","confidence":0.9}]}';

    // Use a clean history with just this extraction prompt
    const extractHistory = [{ role: 'user', content: extractionPrompt }];

    // ⏱️ Timeout guard: extraction is fire-and-forget, don't let it hang
    const EXTRACTION_TIMEOUT_MS = 10000;
    const llmResponse = await Promise.race([
      llmChatFn(userId, extractionPrompt, extractHistory),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Fact extraction timed out after ' + EXTRACTION_TIMEOUT_MS / 1000 + 's')), EXTRACTION_TIMEOUT_MS)
      ),
    ]);

    // LLM returns {type:'message', content:'...'} or {type:'tool', ...}
    let rawText = '';
    if (llmResponse.type === 'message') {
      rawText = llmResponse.content;
    } else if (llmResponse.type === 'tool') {
      // LLM might try to use set_fact tool — extract from args
      if (llmResponse.name === 'set_fact' && llmResponse.args) {
        rawText = JSON.stringify({ facts: [llmResponse.args] });
      } else {
        return; // unexpected tool
      }
    }

    // Parse the JSON
    let parsed;
    try {
      // Strip markdown fences
      const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      // Try to extract JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(cleaned);
      }
    } catch {
      console.log('[Memory] Could not parse extraction response, skipping');
      return;
    }

    const facts = parsed.facts || [];
    if (!Array.isArray(facts) || facts.length === 0) return;

    // ── Save each extracted fact ──────────────────────────────────────────
    for (const fact of facts) {
      if (!fact.key || !fact.value) continue;

      // Normalize key
      const key = fact.key.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      const confidence = typeof fact.confidence === 'number' ? fact.confidence : 0.7;

      // Check if this fact already exists with same value
      const allFacts = await db.getAllFacts(userId);
      const existing = allFacts.find(f => f.key === key);

      if (existing && existing.value === fact.value) {
        // Same key+value — boost confidence (re-confirmation)
        const newConf = Math.min(1.0, (existing.confidence || 0.7) + 0.1);
        await db.setFact(userId, key, fact.value);
        await db.updateFactConfidence(userId, key, newConf);
        continue;
      }

      if (existing && existing.value !== fact.value) {
        // ⚠️ Key exists but value changed → POTENTIAL CONFLICT
        const existingConf = existing.confidence || 0.7;
        if (confidence > existingConf) {
          // New info has higher confidence → accept update, but flag as conflict for review
          console.log('[Memory] ⚠️  Conflict: ' + key + ' → ' + fact.value + ' (was: ' + existing.value + ', conf: ' + confidence + ' vs ' + existingConf + ')');
          await db.setFact(userId, key, fact.value);
          await db.flagFactConflict(userId, key, existing.value);
        } else if (confidence >= existingConf - 0.1) {
          // Similar confidence → flag as conflict, keep old value
          console.log('[Memory] ⚠️  Conflict (kept old): ' + key + ' — new: ' + fact.value + ' vs old: ' + existing.value + ' (conf: ' + confidence + ' vs ' + existingConf + ')');
          await db.flagFactConflict(userId, key, fact.value);
        } else {
          // New info has lower confidence → ignore, but note
          console.log('[Memory] ℹ️  Low-confidence change ignored: ' + key + ' — ' + fact.value + ' (conf: ' + confidence + ' < ' + existingConf + ')');
        }
      } else if (!existing) {
        // New fact — store with confidence
        console.log('[Memory] 🧠 New fact: ' + key + ' → ' + fact.value + ' (confidence: ' + confidence + ')');
        await db.setFact(userId, key, fact.value);
        await db.updateFactConfidence(userId, key, confidence);
      }
    }

    // Invalidate cache so next search picks up new facts
    redisCache.invalidateFactsCache(userId);

    if (facts.length > 0) {
      console.log('[Memory] ✅ Extracted ' + facts.length + ' fact(s) from conversation');
    }
  } catch (err) {
    // Non-fatal — extraction failures should never break the bot
    console.warn('[Memory] Fact extraction failed (non-fatal):', err.message);
  }
}

// ── 3. Memory Importance Scoring & Cleanup ──────────────────────────────────

/**
 * Calculate an importance score (1-10) for a fact based on:
 * - How often it's accessed
 * - How recently it was updated
 * - Whether its key suggests permanence (e.g. "name", "location" vs "lunch_today")
 * - Whether the value contains time-sensitive info (dates, numbers)
 *
 * @param {{key:string, value:string, access_count?:number, updated_at?:string, last_accessed_at?:string}} fact
 * @returns {number} importance score 1-10
 */
function calculateImportance(fact) {
  let score = 3; // baseline

  // ── Key category signals ──────────────────────────────────────────────
  const highImportanceKeys = [
    'name', 'nama', 'full_name', 'location', 'lokasi', 'timezone', 'zon_masa',
    'language', 'bahasa', 'occupation', 'pekerjaan', 'kerja', 'job',
    'diet', 'allergy', 'alergi', 'religion', 'agama',
    'wife', 'husband', 'isteri', 'suami', 'pasangan', 'spouse',
    'mother', 'father', 'ibu', 'ayah', 'parent', 'anak', 'child',
    'birthday', 'birth_date', 'tarikh_lahir',
    'personality', 'personaliti', 'preference', 'keutamaan',
    'goal', 'matlamat', 'target',
  ];
  const mediumImportanceKeys = [
    'sleep', 'tidur', 'wake', 'bangun', 'routine', 'rutin', 'schedule', 'jadual',
    'work_hours', 'waktu_kerja', 'office', 'pejabat',
    'hobby', 'hobi', 'interest', 'minat',
    'phone', 'telefon', 'email', 'contact',
  ];
  const lowImportanceKeys = [
    'lunch', 'makan', 'dinner', 'breakfast', 'sarapan',
    'today', 'hari_ini', 'semalam', 'yesterday', 'esok', 'tomorrow',
    'mood', 'feeling', 'rasa', 'plan', 'rancang',
    'watch', 'tonton', 'movie', 'filem', 'show',
  ];

  const keyLower = fact.key.toLowerCase();
  if (highImportanceKeys.some(k => keyLower.includes(k))) score += 4;
  else if (mediumImportanceKeys.some(k => keyLower.includes(k))) score += 2;
  else if (lowImportanceKeys.some(k => keyLower.includes(k))) score -= 1;

  // ── Access frequency ──────────────────────────────────────────────────
  const accessCount = fact.access_count || 0;
  if (accessCount >= 10) score += 3;
  else if (accessCount >= 5) score += 2;
  else if (accessCount >= 2) score += 1;

  // ── Recency (updated in last 7 days = more important) ─────────────────
  if (fact.updated_at) {
    const updated = new Date(fact.updated_at);
    const daysSinceUpdate = (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate < 1) score += 2;
    else if (daysSinceUpdate < 7) score += 1;
    else if (daysSinceUpdate > 90) score -= 1; // stale
  }

  // ── Value signals ─────────────────────────────────────────────────────
  const value = fact.value || '';
  // Very short values (< 5 chars) might be less meaningful
  if (value.length < 5) score -= 1;
  // Values with dates suggest time-bound info → slightly less permanent
  if (/\d{4}-\d{2}-\d{2}/.test(value)) score -= 1;

  // Clamp to 1-10
  return Math.max(1, Math.min(10, score));
}

/**
 * Get facts with their importance scores.
 * @param {string} userId
 * @returns {Promise<Array<{key:string, value:string, importance:number, access_count:number}>>}
 */
async function getFactsWithImportance(userId) {
  // Query facts with importance metadata from DB
  // Falls back to calculating on-the-fly if columns don't exist yet
  try {
    const { rows } = await db.pool.query(
      `SELECT key, value, importance, access_count, updated_at, last_accessed_at
       FROM memory_facts WHERE user_id = $1`,
      [String(userId)]
    );
    return rows.map(r => ({
      key: r.key,
      value: r.value,
      importance: r.importance || calculateImportance(r),
      access_count: r.access_count || 0,
      updated_at: r.updated_at,
      last_accessed_at: r.last_accessed_at,
    }));
  } catch {
    // Columns might not exist yet — fall back to basic facts + calculate
    const facts = await db.getAllFacts(userId);
    return facts.map(f => ({
      ...f,
      importance: calculateImportance(f),
      access_count: f.access_count || 0,
    }));
  }
}

/**
 * Find facts that should be cleaned up (low importance + stale).
 * Does NOT delete — just returns the list for review or auto-cleanup.
 *
 * @param {string} userId
 * @param {number} [minImportance=3] - facts below this score are candidates
 * @param {number} [staleDays=30] - facts not updated in this many days
 * @returns {Promise<Array<{key:string, value:string, importance:number}>>}
 */
async function findStaleFacts(userId, minImportance = 3, staleDays = 30) {
  const facts = await getFactsWithImportance(userId);
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  const stale = facts.filter(f => {
    const importance = f.importance || calculateImportance(f);
    if (importance >= minImportance) return false; // important enough to keep

    // Check staleness
    const updatedAt = f.updated_at ? new Date(f.updated_at).getTime() : 0;
    const lastAccessed = f.last_accessed_at ? new Date(f.last_accessed_at).getTime() : updatedAt;
    const mostRecent = Math.max(updatedAt, lastAccessed);

    return mostRecent < cutoff;
  });

  return stale;
}

/**
 * Auto-cleanup: delete facts that are low importance AND stale.
 * Safe — only deletes facts with importance < minImportance that haven't been touched in staleDays.
 *
 * @param {string} userId
 * @param {number} [minImportance=3]
 * @param {number} [staleDays=30]
 * @returns {Promise<number>} number of facts deleted
 */
async function autoCleanupFacts(userId, minImportance = 3, staleDays = 30) {
  const stale = await findStaleFacts(userId, minImportance, staleDays);

  if (stale.length === 0) return 0;

  for (const fact of stale) {
    await db.deleteFact(userId, fact.key);
  }

  // Invalidate cache
  redisCache.invalidateFactsCache(userId);

  console.log('[Memory] 🧹 Cleaned up ' + stale.length + ' stale/low-importance fact(s) for user ' + userId);
  return stale.length;
}

/**
 * Increment the access count for facts that were used in a response.
 * Called after a successful search/retrieval.
 *
 * @param {string} userId
 * @param {string[]} factKeys - keys of facts that were accessed
 */
async function recordFactAccess(userId, factKeys) {
  if (!factKeys || factKeys.length === 0) return;
  try {
    // Try with new columns first
    await db.pool.query(
      `UPDATE memory_facts
       SET access_count = COALESCE(access_count, 0) + 1,
           last_accessed_at = NOW()
       WHERE user_id = $1 AND key = ANY($2)`,
      [String(userId), factKeys]
    );
  } catch {
    // Columns might not exist yet — silently ignore
  }
}

// ── 4. Episodic Memory — search past conversations ──────────────────────────

/**
 * Search chat history for past conversations relevant to a user's query.
 * Used when user asks "what did we talk about last week?" or "apa yang saya buat bulan lepas?"
 *
 * @param {string} userId
 * @param {string} query - what the user is asking about
 * @param {number} [limit=10] - max results
 * @returns {Promise<Array<{role:string, content:string, created_at:string}>>}
 */
async function searchEpisodicMemory(userId, query, limit = 10) {
  return db.searchChatHistory(userId, query, limit);
}

/**
 * Get a summary of recent conversation activity.
 * @param {string} userId
 * @param {number} [days=7]
 * @returns {Promise<Array<{date:string, user_count:string, assistant_count:string}>>}
 */
async function getConversationSummary(userId, days = 7) {
  return db.getChatActivitySummary(userId, days);
}

/**
 * Prune old chat history beyond retention period.
 * @param {string} userId
 * @param {number} [keepDays=90]
 * @returns {Promise<number>}
 */
async function pruneOldHistory(userId, keepDays = 90) {
  return db.pruneOldChatHistory(userId, keepDays);
}

// ── 5. Confidence & Conflict Management ─────────────────────────────────────

/**
 * Detect conflicts across all facts and return those needing attention.
 * @param {string} userId
 * @returns {Promise<Array<{key:string, value:string, previous_value:string|null, confidence:number}>>}
 */
async function getConflicts(userId) {
  return db.getConflictFacts(userId);
}

/**
 * Resolve a specific conflict.
 * @param {string} userId
 * @param {string} key
 * @param {'keep_current'|'restore_previous'} resolution
 */
async function resolveConflict(userId, key, resolution) {
  await db.resolveFactConflict(userId, key, resolution);
  redisCache.invalidateFactsCache(userId);
  console.log('[Memory] ✅ Conflict resolved: ' + key + ' → ' + resolution);
}

/**
 * Boost confidence on a fact (user explicitly confirmed it).
 * @param {string} userId
 * @param {string} key
 */
async function boostConfidence(userId, key) {
  const facts = await db.getAllFacts(userId);
  const fact = facts.find(f => f.key === key);
  if (fact) {
    const newConf = Math.min(1.0, (fact.confidence || 0.7) + 0.15);
    await db.updateFactConfidence(userId, key, newConf);
    redisCache.invalidateFactsCache(userId);
  }
}

// ── 6. Daily Reflection & Summarization ─────────────────────────────────────

/**
 * Generate a daily reflection using the LLM.
 * Summarizes today's conversations, detects patterns, notes fact changes.
 * Saves the result to the reflections table.
 *
 * @param {string} userId
 * @param {object} llmChatFn - the LLM chat function (e.g. llm.chat)
 * @returns {Promise<string|null>} the generated reflection text, or null if skipped
 */
async function generateDailyReflection(userId, llmChatFn) {
  try {
    const tz = process.env.TIMEZONE || 'UTC';
    // Use DB's CURRENT_DATE (timezone-aware) for consistency with getTodayReflection
    const { rows: dateRows } = await db.pool.query(
      `SELECT (CURRENT_DATE AT TIME ZONE $1)::date AS today`,
      [tz]
    );
    const today = dateRows[0].today instanceof Date
      ? dateRows[0].today.toISOString().slice(0, 10)
      : String(dateRows[0].today).slice(0, 10);

    const todayStart = today + 'T00:00:00+08:00';
    const todayEnd = today + 'T23:59:59+08:00';

    // Gather today's data
    const [chatHistory, activity, facts, notes, reminders, events, conflicts] = await Promise.all([
      db.getChatHistoryInRange(userId, todayStart, todayEnd),
      db.getChatActivitySummary(userId, 1),
      db.getAllFacts(userId),
      db.getRecentNotes(userId, 20),
      db.getTodayReminders(userId),
      db.getTodayEvents(userId),
      db.getConflictFacts(userId),
    ]);

    // Skip if no activity today
    const userMessages = chatHistory.filter(h => h.role === 'user');
    if (userMessages.length === 0 && notes.length === 0 && reminders.length === 0) {
      console.log('[Memory] 📭 No activity today — skipping reflection');
      return null;
    }

    // Build context for the LLM
    let contextStr = '─────────────── TODAY\'S CONTEXT ───────────────\n';

    if (userMessages.length > 0) {
      contextStr += '\n💬 CONVERSATIONS (' + userMessages.length + ' messages):\n';
      userMessages.slice(-10).forEach(m => {
        const truncated = m.content.length > 100 ? m.content.slice(0, 100) + '…' : m.content;
        contextStr += '• ' + truncated + '\n';
      });
    }

    if (notes.length > 0) {
      contextStr += '\n📝 NOTES (' + notes.length + '):\n';
      notes.slice(0, 10).forEach(n => {
        const truncated = n.content.length > 80 ? n.content.slice(0, 80) + '…' : n.content;
        contextStr += '• ' + truncated + '\n';
      });
    }

    if (reminders.length > 0) {
      contextStr += '\n⏰ REMINDERS (' + reminders.length + '):\n';
      reminders.forEach(r => contextStr += '• ' + r.text + '\n');
    }

    if (events.length > 0) {
      contextStr += '\n📅 EVENTS (' + events.length + '):\n';
      events.forEach(e => contextStr += '• ' + e.title + '\n');
    }

    if (facts.length > 0) {
      contextStr += '\n🧠 FACTS ABOUT USER:\n';
      facts.forEach(f => contextStr += '• ' + f.key + ': ' + f.value + '\n');
    }

    if (conflicts.length > 0) {
      contextStr += '\n⚠️ UNRESOLVED CONFLICTS:\n';
      conflicts.forEach(c => contextStr += '• ' + c.key + ': current="' + c.value + '" vs previous="' + c.previous_value + '"\n');
    }

    const reflectionPrompt =
      '🧘 DAILY REFLECTION TASK\n\n' +
      'You are an AI reflecting on today\'s interactions with the user.\n' +
      'Your job: analyze and summarize what happened today, identify patterns, and note developments.\n\n' +
      contextStr + '\n' +
      '──────────────────────────────────────────────\n\n' +
      'Write a warm, personal reflection with these sections:\n\n' +
      '1. 📋 *SUMMARY* — What the user did/talked about today (2-3 sentences)\n' +
      '2. 🔍 *PATTERNS* — Any recurring themes, habits, or trends you notice across their activity (or "No clear patterns yet")\n' +
      '3. 🔄 *CHANGES* — Any facts that were updated, new info learned, or conflicts to resolve\n' +
      '4. 💡 *SUGGESTION* — One helpful suggestion or gentle nudge based on today\'s activity (e.g. incomplete tasks, upcoming deadlines, wellness tip)\n\n' +
      'Tone: Warm, supportive, conversational. Like a thoughtful friend.\n' +
      'Language: Match the user\'s primary language style.\n' +
      'Keep it concise — max 200 words total.\n\n' +
      'Respond in natural paragraph format (NOT JSON). Just write the reflection directly.';

    const reflectHistory = [{ role: 'user', content: reflectionPrompt }];
    const llmResponse = await llmChatFn(userId, reflectionPrompt, reflectHistory);

    const reflectionText = llmResponse.type === 'message' ? llmResponse.content : 'Reflection generated.';

    // Extract pattern insights and fact changes for structured storage
    let patternInsights = null;
    let factChanges = null;

    // Extract patterns section
    const patternMatch = reflectionText.match(/\*\s*PATTERNS?\*?\*?[\s\S]*?(?=\d\.\s*\*|$)/i);
    if (patternMatch) patternInsights = patternMatch[0].trim().slice(0, 500);

    // Extract changes section
    const changesMatch = reflectionText.match(/\*\s*CHANGES?\*?\*?[\s\S]*?(?=\d\.\s*\*|$)/i);
    if (changesMatch) factChanges = changesMatch[0].trim().slice(0, 500);

    // Save to DB
    await db.saveReflection(userId, today, reflectionText, patternInsights, factChanges);
    console.log('[Memory] 📝 Daily reflection saved for ' + today);

    return reflectionText;
  } catch (err) {
    console.warn('[Memory] Daily reflection generation failed:', err.message);
    return null;
  }
}

/**
 * Get the most recent reflections for the user.
 * @param {string} userId
 * @param {number} [limit=7]
 * @returns {Promise<Array>}
 */
async function getReflections(userId, limit = 7) {
  return db.getRecentReflections(userId, limit);
}

// ── 7. Memory Write Strategy ───────────────────────────────────────────────

/**
 * Score a fact for STORAGE importance at write time.
 * Different from retrieval relevance — this decides whether to KEEP the fact.
 * Uses: key category weight + confidence + value richness + domain signals.
 *
 * @param {{key:string, value:string, confidence?:number}} fact
 * @returns {{score: number, tier: 'critical'|'important'|'normal'|'transient', reason: string}}
 */
function scoreFactForStorage(fact) {
  let score = 0;
  const reasons = [];

  const key = (fact.key || '').toLowerCase();
  const value = (fact.value || '');
  const confidence = fact.confidence || 0.7;

  // ── Key category signals ────────────────────────────────────────────
  const CRITICAL_KEYS = [
    'name', 'nama', 'full_name', 'location', 'lokasi', 'timezone',
    'language', 'bahasa', 'occupation', 'pekerjaan', 'job',
    'diet', 'allergy', 'alergi', 'religion', 'agama',
    'wife', 'husband', 'isteri', 'suami', 'spouse', 'pasangan',
    'parent', 'ibu', 'ayah', 'mother', 'father',
    'birthday', 'birth_date', 'tarikh_lahir',
    'personality', 'personaliti',
  ];
  const IMPORTANT_KEYS = [
    'sleep', 'tidur', 'wake', 'bangun', 'routine', 'rutin',
    'schedule', 'jadual', 'work_hours', 'office', 'pejabat',
    'hobby', 'hobi', 'interest', 'minat', 'goal', 'matlamat',
    'phone', 'telefon', 'email', 'contact', 'address', 'alamat',
    'preference', 'keutamaan', 'prefer',
  ];

  if (CRITICAL_KEYS.some(k => key.includes(k))) {
    score += 40;
    reasons.push('critical key category');
  } else if (IMPORTANT_KEYS.some(k => key.includes(k))) {
    score += 25;
    reasons.push('important key category');
  } else {
    score += 10;
  }

  // ── Confidence weighting ────────────────────────────────────────────
  if (confidence >= 0.9) {
    score += 20;
    reasons.push('high confidence');
  } else if (confidence >= 0.7) {
    score += 12;
    reasons.push('moderate confidence');
  } else if (confidence >= 0.5) {
    score += 6;
    reasons.push('low confidence');
  } else {
    score += 2;
    reasons.push('very low confidence');
  }

  // ── Value richness ──────────────────────────────────────────────────
  if (value.length >= 20) {
    score += 8;
    reasons.push('rich value');
  } else if (value.length >= 5) {
    score += 4;
  } else {
    score -= 2;
    reasons.push('thin value');
  }

  // ── Time-sensitivity penalty ────────────────────────────────────────
  // Facts with dates/times in them are likely transient
  if (/\d{4}-\d{2}-\d{2}/.test(value) || /\d{1,2}[:.]\d{2}/.test(value)) {
    score -= 8;
    reasons.push('contains time/date (transient)');
  }

  // ── Key signals transience ──────────────────────────────────────────
  const transientKeys = [
    'lunch', 'makan', 'dinner', 'breakfast', 'sarapan',
    'today', 'hari_ini', 'semalam', 'yesterday', 'esok', 'tomorrow',
    'mood', 'feeling', 'rasa', 'plan_today', 'rancang_hari_ini',
    'watch', 'tonton', 'movie', 'filem',
  ];
  if (transientKeys.some(k => key.includes(k))) {
    score -= 15;
    reasons.push('transient key — likely outdated soon');
  }

  // ── Determine tier ──────────────────────────────────────────────────
  let tier;
  if (score >= 55) tier = 'critical';
  else if (score >= 35) tier = 'important';
  else if (score >= 15) tier = 'normal';
  else tier = 'transient';

  return { score, tier, reason: reasons.join('; ') };
}

/**
 * Calculate a memory decay weight using exponential decay.
 * weight = importance × e^(-λ × ageInDays)
 *
 * λ (decay rate) varies by tier:
 *   - critical:  λ = 0.001  (half-life ~693 days)
 *   - important: λ = 0.005  (half-life ~139 days)
 *   - normal:    λ = 0.015  (half-life ~46 days)
 *   - transient: λ = 0.050  (half-life ~14 days)
 *
 * @param {object} fact - memory fact with importance, updated_at, tier
 * @param {{key:string, value:string, importance?:number, updated_at?:string, tier?:string}} fact
 * @returns {{weight: number, decayed: boolean, effectiveImportance: number}}
 */
function memoryDecayWeight(fact) {
  const importance = fact.importance || 5;
  const tier = fact.tier || 'normal';

  // Decay rate (λ) by tier
  const lambda = {
    critical: 0.001,
    important: 0.005,
    normal: 0.015,
    transient: 0.050,
  }[tier] || 0.015;

  // Age in days
  const updatedAt = fact.updated_at ? new Date(fact.updated_at) : new Date();
  const ageDays = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);

  // Exponential decay: weight = importance × e^(-λ × age)
  const weight = importance * Math.exp(-lambda * ageDays);

  // Effective importance (rounded to 1 decimal)
  const effectiveImportance = Math.round(weight * 10) / 10;

  // Consider "decayed" if weight has dropped by more than 30%
  const decayed = weight < importance * 0.7;

  return { weight, decayed, effectiveImportance };
}

/**
 * Compress old/similar facts into summarized versions.
 * For facts older than threshold, if multiple facts share a category,
 * merge them into a single summarized fact.
 *
 * @param {string} userId
 * @param {number} [olderThanDays=60] — only compress facts older than this
 * @returns {Promise<{compressed: number, message: string}>}
 */
async function compressOldFacts(userId, olderThanDays = 60) {
  const allFacts = await db.getAllFacts(userId);
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  // Find old facts
  const oldFacts = allFacts.filter(f => {
    const updatedAt = f.updated_at ? new Date(f.updated_at).getTime() : 0;
    return updatedAt < cutoff;
  });

  if (oldFacts.length < 3) {
    return { compressed: 0, message: 'Not enough old facts to compress' };
  }

  // Group by key prefix (category)
  const groups = {};
  for (const fact of oldFacts) {
    const prefix = fact.key.split('_')[0] || 'misc';
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(fact);
  }

  let compressed = 0;

  // For groups with 2+ facts, merge them
  for (const [prefix, facts] of Object.entries(groups)) {
    if (facts.length < 2) continue;

    // Create a compressed summary
    const values = facts.map(f => f.value).join(' | ');
    const compressedKey = prefix + '_summary';
    const compressedValue = '[Compressed ' + facts.length + ' facts]: ' + values.slice(0, 500);

    // Save compressed version
    await db.setFact(userId, compressedKey, compressedValue);
    await db.updateFactConfidence(userId, compressedKey, 0.6); // lower confidence for compressed

    // Delete original old facts
    for (const fact of facts) {
      // Don't delete critical facts even if old
      const storageScore = scoreFactForStorage(fact);
      if (storageScore.tier === 'critical') continue;

      await db.deleteFact(userId, fact.key);
      compressed++;
    }

    if (compressed > 0) {
      console.log('[Memory] 🗜️ Compressed ' + facts.length + ' old ' + prefix + ' facts into ' + compressedKey);
    }
  }

  if (compressed > 0) {
    redisCache.invalidateFactsCache(userId);
  }

  return {
    compressed,
    message: compressed > 0
      ? 'Compressed ' + compressed + ' old fact(s) into summaries'
      : 'No facts needed compression',
  };
}

/**
 * Smart fact write with strategy:
 * 1. Score the incoming fact for storage importance
 * 2. Check for existing fact with same key
 * 3. Resolve conflicts using validator's conflict resolution
 * 4. Apply decay to existing fact if overwriting
 * 5. Tag fact with fact-lock tier (verified/inferred/uncertain)
 *
 * @param {string} userId
 * @param {string} key
 * @param {string} value
 * @param {object} [options]
 * @param {number} [options.confidence=0.7]
 * @param {string} [options.source='conversation'] - 'explicit'|'conversation'|'inferred'
 * @returns {Promise<{action: 'created'|'updated'|'conflict'|'skipped', reason: string}>}
 */
async function writeFactWithStrategy(userId, key, value, options = {}) {
  const confidence = options.confidence || 0.7;
  const source = options.source || 'conversation';

  // Normalize key
  const normalizedKey = key.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

  // Score for storage
  const storageScore = scoreFactForStorage({ key: normalizedKey, value, confidence });

  // Skip transient facts with very low scores
  if (storageScore.tier === 'transient' && storageScore.score < 10) {
    console.log('[Memory] ⏭️ Skipping transient fact: ' + normalizedKey + ' (score: ' + storageScore.score + ')');
    return { action: 'skipped', reason: 'Transient fact with low storage score: ' + storageScore.reason };
  }

  // Check for existing fact
  const allFacts = await db.getAllFacts(userId);
  const existing = allFacts.find(f => f.key === normalizedKey);

  if (!existing) {
    // New fact — store with storage tier metadata
    await db.setFact(userId, normalizedKey, value);
    await db.updateFactConfidence(userId, normalizedKey, confidence);

    // Store importance and tier metadata
    try {
      await db.pool.query(
        `UPDATE memory_facts SET importance = $3 WHERE user_id = $1 AND key = $2`,
        [String(userId), normalizedKey, storageScore.score]
      );
    } catch { /* column might not exist yet */ }

    console.log('[Memory] ✅ New fact stored: ' + normalizedKey + ' (tier: ' + storageScore.tier + ', score: ' + storageScore.score + ')');
    redisCache.invalidateFactsCache(userId);
    return { action: 'created', reason: 'New ' + storageScore.tier + ' fact: ' + storageScore.reason };
  }

  // Existing fact — check if value changed
  if (existing.value === value) {
    // Same value — boost confidence
    const newConf = Math.min(1.0, (existing.confidence || 0.7) + 0.1);
    await db.updateFactConfidence(userId, normalizedKey, newConf);
    return { action: 'updated', reason: 'Re-confirmed — confidence boosted to ' + newConf.toFixed(2) };
  }

  // Value changed — conflict resolution using validator
  const validator = require('../llm/validator');
  const resolution = validator.resolveFactConflict(existing, {
    key: normalizedKey,
    value,
    confidence,
    created_at: new Date().toISOString(),
  });

  if (resolution.keep === 'incoming') {
    await db.setFact(userId, normalizedKey, value);
    await db.updateFactConfidence(userId, normalizedKey, confidence);
    console.log('[Memory] ⚠️ Conflict resolved — new value accepted: ' + normalizedKey + ' → ' + value);
    redisCache.invalidateFactsCache(userId);
    return { action: 'updated', reason: resolution.reason };
  }

  // Keep existing — flag conflict for review
  try {
    await db.flagFactConflict(userId, normalizedKey, value);
  } catch { /* may not support conflict flagging */ }

  console.log('[Memory] ⚠️ Conflict — kept existing: ' + normalizedKey + ' (new value ignored: ' + value.slice(0, 50) + ')');
  return { action: 'conflict', reason: resolution.reason };
}

// ── Embedding-Based Semantic Search (Item #10) ─────────────────────────────
// Uses ILMU BGE-M3 (primary) or DeepSeek (fallback) for semantic embeddings.
// Falls back to keyword search when embeddings are unavailable.
//
// ILMU BGE-M3 is preferred: cheaper (RM 0.04/M tok), Malaysian-hosted,
// and 1024-dim vectors with excellent BM/rojak understanding.
// DeepSeek is kept as fallback for users without ILMU access.

const ilmuranker = require('../llm/embeddings');

/**
 * Perform an embedding-based semantic search on memory facts.
 * Uses DeepSeek's embedding endpoint if DEEPSEEK_API_KEY is configured.
 * Falls back gracefully to keyword-only search.
 *
 * @param {string} userId
 * @param {string} query - user's message/question
 * @param {object} [options]
 * @param {number} [options.limit=8] - max facts to return
 * @param {boolean} [options.useEmbeddings=true] - whether to attempt embedding search
 * @returns {Promise<Array>} ranked facts
 */
async function semanticSearch(userId, query, options = {}) {
  const limit = options.limit || 8;
  const useEmbeddings = options.useEmbeddings !== false;

  // Get all facts first (we need them for both keyword and embedding search)
  const allFacts = await db.getAllFacts(userId);
  if (!allFacts || allFacts.length === 0) return [];

  // ── Attempt embedding-based search ────────────────────────────────────
  if (useEmbeddings && allFacts.length > 3) {
    // Try ILMU BGE-M3 first (cheaper, Malaysian-optimized)
    if (ilmuranker.isAvailable()) {
      try {
        const result = await searchWithIlmuEmbeddings(query, allFacts, limit);
        if (result && result.length > 0) return result;
      } catch (err) {
        console.warn('[Memory] ILMU embedding search failed, trying DeepSeek:', err.message);
      }
    }

    // Fallback: DeepSeek embeddings
    if (process.env.DEEPSEEK_API_KEY) {
      try {
        const result = await searchWithDeepSeekEmbeddings(query, allFacts, limit);
        if (result && result.length > 0) return result;
      } catch (err) {
        console.warn('[Memory] DeepSeek embedding search failed, falling back to keyword:', err.message);
      }
    }
  }

  // ── Fallback: keyword-based search ────────────────────────────────────
  return searchFacts(userId, query, limit);
}

/**
 * Search facts using ILMU BGE-M3 embeddings + optional reranker.
 * @returns {Promise<Array|null>} ranked facts or null
 */
async function searchWithIlmuEmbeddings(query, allFacts, limit) {
  const factTexts = allFacts.map(f => f.key + ': ' + f.value);

  // Get embeddings for query + all facts in one batch
  const allTexts = [query, ...factTexts];
  const allEmbeddings = await ilmuranker.getEmbeddingsBatch(allTexts);

  if (!allEmbeddings || allEmbeddings.length !== allTexts.length) return null;

  const queryEmbedding = allEmbeddings[0];
  const factEmbeddings = allEmbeddings.slice(1);

  // Cosine similarity ranking
  const ranked = allFacts.map((fact, i) => ({
    fact,
    score: ilmuranker.cosineSimilarity(queryEmbedding, factEmbeddings[i]),
  }));
  ranked.sort((a, b) => b.score - a.score);

  console.log('[Memory] 🔍 ILMU BGE-M3 search: top score=' + ranked[0]?.score?.toFixed(3) +
    ' for "' + query.slice(0, 50) + '"');

  // ── Optional: rerank top candidates for precision ───────────────────
  let topCandidates = ranked.slice(0, Math.min(limit * 2, ranked.length));
  const rerankDocs = topCandidates.map(r => r.fact.key + ': ' + r.fact.value);

  const reranked = await ilmuranker.rerank(query, rerankDocs, { topN: limit });
  if (reranked && reranked.length > 0) {
    console.log('[Memory] 🔄 Reranker applied: top score=' + reranked[0]?.score?.toFixed(3));
    return reranked.map(r => ({
      ...allFacts[r.index],
      relevance: Math.round(r.score * 100) / 100,
      searchMethod: 'bge-m3+rerank',
    }));
  }

  // Fallback: use raw cosine similarity (no reranker)
  return ranked.slice(0, limit).map(r => ({
    ...r.fact,
    relevance: Math.round(r.score * 100) / 100,
    searchMethod: 'bge-m3',
  }));
}

/**
 * Search facts using DeepSeek embeddings (fallback).
 */
async function searchWithDeepSeekEmbeddings(query, allFacts, limit) {
  const factTexts = allFacts.map(f => f.key + ': ' + f.value);

  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) return null;

  const factEmbeddings = await getEmbeddingsBatch(factTexts);
  if (!factEmbeddings || factEmbeddings.length !== factTexts.length) return null;

  const ranked = allFacts.map((fact, i) => ({
    fact,
    score: cosineSimilarity(queryEmbedding, factEmbeddings[i]),
  }));
  ranked.sort((a, b) => b.score - a.score);

  console.log('[Memory] 🔍 DeepSeek embedding search: top score=' + ranked[0]?.score?.toFixed(3) +
    ' for "' + query.slice(0, 50) + '"');

  return ranked.slice(0, limit).map(r => ({
    ...r.fact,
    relevance: Math.round(r.score * 100) / 100,
    searchMethod: 'deepseek',
  }));
}

/**
 * Get embedding vector for a single text using DeepSeek API.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function getEmbedding(text) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch('https://api.deepseek.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-embedding',
        input: text,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data?.data?.[0]?.embedding || null;
  } catch {
    return null; // Silently fall back
  }
}

/**
 * Get embeddings for multiple texts (batch or sequential).
 * @param {string[]} texts
 * @returns {Promise<Array<number[]>|null>}
 */
async function getEmbeddingsBatch(texts) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  // Try batch endpoint first
  try {
    const response = await fetch('https://api.deepseek.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-embedding',
        input: texts,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = await response.json();
      if (data?.data?.length === texts.length) {
        return data.data.map(d => d.embedding);
      }
    }
  } catch { /* try sequential */ }

  // Fallback: sequential embedding requests
  const embeddings = [];
  for (const text of texts) {
    const emb = await getEmbedding(text);
    if (!emb) return null;
    embeddings.push(emb);
  }
  return embeddings;
}

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

module.exports = {
  searchFacts,
  extractFactsFromChat,
  calculateImportance,
  getFactsWithImportance,
  findStaleFacts,
  autoCleanupFacts,
  recordFactAccess,
  // Episodic memory
  searchEpisodicMemory,
  getConversationSummary,
  pruneOldHistory,
  // Confidence & conflict
  getConflicts,
  resolveConflict,
  boostConfidence,
  // Daily reflection
  generateDailyReflection,
  getReflections,
  // Memory Write Strategy (Fasa 2 upgrade)
  scoreFactForStorage,
  memoryDecayWeight,
  compressOldFacts,
  writeFactWithStrategy,
  // Embedding search (Item #10)
  semanticSearch,
};
