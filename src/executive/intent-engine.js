// src/executive/intent-engine.js
// ── Advanced Intent Detection Engine ───────────────────────────────────────
// Fasa 1: More sophisticated than simple regex matching.
// Uses layered detection: fast keyword → context-aware → confidence scoring.
//
// New capabilities:
//   - Confidence scoring (0.0-1.0) for every classification
//   - Context-aware escalation (previous messages influence intent)
//   - Sub-intent classification (what TYPE of task?)
//   - Mood/sentiment detection
//   - Urgency detection
//   - Language mix detection (BM/EN/rojak)

// ── Intent Categories ──────────────────────────────────────────────────────
const INTENT_CATEGORIES = {
  GREETING: 'greeting',
  QUESTION_FACT: 'question_fact',       // "What time is it?" — factual
  QUESTION_OPINION: 'question_opinion', // "What do you think about X?"
  QUESTION_HOWTO: 'question_howto',     // "How do I do X?"
  TASK_REMINDER: 'task_reminder',       // Create/manage reminders
  TASK_EVENT: 'task_event',             // Create/manage calendar events
  TASK_NOTE: 'task_note',               // Save notes
  TASK_MEMORY: 'task_memory',           // Remember facts
  TASK_SEARCH: 'task_search',           // Search web
  TASK_PLANNING: 'task_planning',       // Multi-step planning
  TASK_GOAL: 'task_goal',              // Goal setting/tracking
  TASK_PROJECT: 'task_project',        // Project management
  CONVERSATION: 'conversation',         // Casual chat
  FEEDBACK: 'feedback',                // Praise/complaint about bot
  COMMAND_CONFIG: 'command_config',     // Bot configuration
  REFLECTION: 'reflection',            // Self-reflection request
  EMERGENCY: 'emergency',              // Urgent/important
  UNKNOWN: 'unknown',
};

// ── Fast Pattern Matchers ──────────────────────────────────────────────────
const FAST_PATTERNS = {
  greeting: [
    /^(hi|hello|hey|hai|helo|selamat\s*(pagi|petang|malam|tengahari)|assalam|salam|yo|sup|what's\s*up|wsup)\b/i,
    /^(apa\s*khabar|how\s*are\s*you|how's\s*it\s*going|howdy)\b/i,
    /^(ok|okay|baik|baiklah|alright|fine|bagus)\b/i,
  ],
  gratitude: [
    /^(thanks|thank\s*you|terima\s*kasih|tq|thx|ty|makasih|good\s*(job|bot)|nice|great|awesome|terbaik|power)\b/i,
  ],
  farewell: [
    /^(bye|goodbye|bai|jumpa|see\s*you|night|selamat\s*malam|good\s*night|babai|bye\s*bye)\b/i,
  ],
  timeQuery: [
    /^(pukul\s*berapa|jam\s*berapa|what\s*time|time\s*now|current\s*time|time\s*check)\b/i,
    /^(hari\s*apa|what\s*day|today\s*date|tarikh|hari\s*ni\s*apa)\b/i,
    /^(sekarang\s*(pukul|jam|hari|tarikh))\b/i,
  ],
  botIdentity: [
    /^(nama\s*(awak|ko|kau|bot)|what('?s| is) your name|who are you|siapa\s*(awak|ko|kau|nama))\b/i,
    /^(boleh\s*(buat|tolong)\s*apa|what can you do|apa\s*(function|fungsi|boleh\s*buat)|capabilities)\b/i,
  ],
};

const DEEP_PATTERNS = {
  reminder: [
    /ingatkan|remind(er)?|peringatan|notify|notification|alarm/i,
    /(set|buat|create|add|tambah)\s*(reminder|peringatan|alarm)/i,
  ],
  event: [
    /jadual|schedule|kalendar|calendar|event|temujanji|appointment/i,
    /(masuk|add|tambah)\s*(dalam|ke)\s*(kalendar|calendar|jadual|schedule)/i,
  ],
  note: [
    /(simpan|save|ingat|remember)\s*(nota|note|fact|fakta|info|maklumat)/i,
    /(tulis|catat|rekod|record)\s*(nota|note)/i,
  ],
  search: [
    /(cari|search|google)\s*(dalam|online|internet|google|web|berita|news|terkini|untuk|tentang|about|for)?/i,
    /(check|semak|checkkan)\s*(harga|price|news|berita|status)/i,
  ],
  planning: [
    /plan|rancang|planning|strategy|strategi|roadmap/i,
    /step|langkah|process|proses|workflow|tutorial|guide|panduan/i,
    /breakdown|pecahkan|bahagi\s*(task|kerja|tugas)/i,
  ],
  goal: [
    /goal|matlamat|target|sasaran|objective|objektif/i,
    /(nak\s*capai|nak\s*kejar|nak\s*achieve|want\s*to\s*achieve)/i,
    /(resolution|azam|tekad)/i,
  ],
  project: [
    /project|projek|sambung\s*(projek|kerja|task|buat)|continue/i,
    /(manage|urus)\s*(project|projek)/i,
  ],
  analysis: [
    /analisis|analisa|analy(s|z)e|breakdown|bandingkan|compare/i,
    /suggest|cadang|recommend|syor|nasihat\s*(apa|macam)/i,
    /patut\s*(ke|tak)|should\s*i|advisable|sesuai\s*ke|baik\s*mana|which\s*(is|one)/i,
  ],
  purchase: [
    /\b(beli|nak\s*beli|buy|purchase|membeli)\b/i,
    /berapa\s*(kos|harga|budget|cost|price)|estimate|anggar/i,
  ],
};

// ── Mood/Sentiment Indicators ──────────────────────────────────────────────
const MOOD_PATTERNS = {
  happy: [/seronok|happy|gembira|best|bestnya|nice|bagusnya|excited|teruja|yay/i],
  sad: [/sedih|sad|down|murung|kecewa|disappointed|frustrated|frust/i],
  angry: [/marah|angry|geram|bengang|annoyed|menyampah|fed\s*up/i],
  tired: [/penat|letih|tired|exhausted|ngantuk|sleepy|tak\s*larat/i],
  anxious: [/risau|bimbang|anxious|worried|nervous|gugup|scared|takut/i],
  motivated: [/semangat|motivated|bersemangat|pumped|ready|bersedia|jom/i],
  confused: [/confused|keliru|tak\s*faham|don't\s*understand|confusing|pening/i],
};

// ── Urgency Indicators ─────────────────────────────────────────────────────
const URGENCY_PATTERNS = [
  /\b(urgent|kecemasan|emergency|segera|asap|cepat|now|sekarang\s*juga)\b/i,
  /\b(penting|critical|kritikal|must|mesti|wajib|perlu\s*cepat)\b/i,
  /\!{2,}/, // multiple exclamation marks
  /\b(HELP|TOLONG|EMERGENCY)\b/,
];

// ── Context-Aware Escalation ────────────────────────────────────────────────
// Words that, when repeated from previous messages, suggest task continuation
const CONTINUATION_SIGNALS = [
  'lagi', 'also', 'juga', 'then', 'lepas\s*tu', 'kemudian',
  'next', 'seterusnya', 'continue', 'sambung', 'and\s*also',
  'one\s*more', 'satu\s*lagi', 'add\s*on', 'tambah\s*lagi',
];

// ── Confidence Scoring Engine ───────────────────────────────────────────────

/**
 * Score a match against a set of patterns with weights.
 * @param {string} text - user message
 * @param {Array<RegExp|{pattern:RegExp, weight:number}>} patterns
 * @returns {number} confidence 0.0-1.0
 */
function scorePatterns(text, patterns) {
  if (!patterns || patterns.length === 0) return 0;

  let totalWeight = 0;
  let matchWeight = 0;

  for (const p of patterns) {
    const pattern = p.pattern || p;
    const weight = p.weight || 1.0;
    totalWeight += weight;

    if (pattern.test(text)) {
      matchWeight += weight;
    }
  }

  return totalWeight > 0 ? matchWeight / totalWeight : 0;
}

/**
 * Detect mood from text.
 * @param {string} text
 * @returns {{mood: string, confidence: number}}
 */
function detectMood(text) {
  let bestMood = 'neutral';
  let bestConf = 0;

  for (const [mood, patterns] of Object.entries(MOOD_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        const conf = 0.6; // each mood hit is moderate confidence
        if (conf > bestConf) {
          bestMood = mood;
          bestConf = conf;
        }
      }
    }
  }

  return { mood: bestMood, confidence: bestConf };
}

/**
 * Detect urgency level.
 * @param {string} text
 * @returns {{isUrgent: boolean, confidence: number}}
 */
function detectUrgency(text) {
  let matchCount = 0;
  let totalConf = 0;

  for (const pattern of URGENCY_PATTERNS) {
    if (pattern.test(text)) {
      matchCount++;
      totalConf += 0.7;
    }
  }

  // Multiple exclamation marks is a weaker signal
  if (/\!{3,}/.test(text)) {
    totalConf += 0.3;
  }

  return {
    isUrgent: matchCount > 0,
    confidence: Math.min(1.0, totalConf),
  };
}

/**
 * Detect language mix (BM, EN, Rojak).
 * @param {string} text
 * @returns {{language: 'bm'|'en'|'rojak', confidence: number}}
 */
function detectLanguage(text) {
  const bmWords = /\b(saya|aku|awak|kau|dia|kita|kami|mereka|ini|itu|dan|atau|tapi|tetapi|yang|dengan|untuk|pada|dari|ke|di|sebab|kerana|boleh|nak|mahu|tahu|faham|bagi|ambil|buat|pergi|datang|ada|tiada|tak|bukan|ya|sangat|juga|pun|lah|kah|tah|ni|tu|je|kat|ni|dah|belum|akan|sedang|telah|masih|baru|lama|cepat|lambat|besar|kecil|baik|buruk|cantik|hensem|mahal|murah)\b/gi;
  const enWords = /\b(i|you|he|she|it|we|they|this|that|and|or|but|because|with|for|from|to|at|in|on|can|will|would|should|could|want|need|know|understand|get|take|make|go|come|have|has|had|is|are|was|were|not|yes|no|very|also|too|already|yet|still|just|new|old|big|small|good|bad|expensive|cheap)\b/gi;

  const bmMatches = (text.match(bmWords) || []).length;
  const enMatches = (text.match(enWords) || []).length;
  const total = bmMatches + enMatches;

  if (total === 0) return { language: 'en', confidence: 0.5 };

  const bmRatio = bmMatches / total;

  if (bmRatio > 0.8) return { language: 'bm', confidence: bmRatio };
  if (bmRatio < 0.2) return { language: 'en', confidence: 1 - bmRatio };
  return { language: 'rojak', confidence: Math.abs(bmRatio - 0.5) * 2 };
}

// ── Main Intent Detection ──────────────────────────────────────────────────

/**
 * Advanced intent detection with confidence scoring, mood, urgency, 
 * and context-aware escalation.
 * 
 * @param {string} text - user message
 * @param {object} [context] - optional context from previous messages
 * @param {Array} [context.recentMessages] - last few message texts
 * @param {object} [context.workingMemory] - current working memory state
 * @returns {{
 *   tier: 'fast'|'medium'|'deep',
 *   category: string,
 *   subCategory: string,
 *   confidence: number,
 *   mood: string,
 *   moodConfidence: number,
 *   isUrgent: boolean,
 *   urgencyConfidence: number,
 *   language: string,
 *   reason: string,
 *   needsEscalation: boolean,
 *   escalationReason: string
 * }}
 */
function detectIntentAdvanced(text, context = {}) {
  const lower = text.toLowerCase().trim();
  const wordCount = lower.split(/\s+/).length;
  const questionCount = (lower.match(/\?/g) || []).length;

  // ── Step 1: Fast pattern matching ─────────────────────────────────────
  let category = INTENT_CATEGORIES.UNKNOWN;
  let confidence = 0.5;
  let reason = '';

  // Check greetings
  for (const pattern of FAST_PATTERNS.greeting) {
    if (pattern.test(lower)) {
      category = INTENT_CATEGORIES.GREETING;
      confidence = 0.95;
      reason = 'greeting detected';
      break;
    }
  }

  // Check gratitude
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    for (const pattern of FAST_PATTERNS.gratitude) {
      if (pattern.test(lower)) {
        category = INTENT_CATEGORIES.FEEDBACK;
        confidence = 0.9;
        reason = 'gratitude/feedback';
        break;
      }
    }
  }

  // Check farewell
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    for (const pattern of FAST_PATTERNS.farewell) {
      if (pattern.test(lower)) {
        category = INTENT_CATEGORIES.GREETING;
        confidence = 0.95;
        reason = 'farewell';
        break;
      }
    }
  }

  // Check time queries
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    for (const pattern of FAST_PATTERNS.timeQuery) {
      if (pattern.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_FACT;
        confidence = 0.95;
        reason = 'time/date query';
        break;
      }
    }
  }

  // Check bot identity
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    for (const pattern of FAST_PATTERNS.botIdentity) {
      if (pattern.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_FACT;
        confidence = 0.9;
        reason = 'bot identity question';
        break;
      }
    }
  }

  // ── Step 2: Deep pattern matching ─────────────────────────────────────
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    const deepChecks = [
      { patterns: DEEP_PATTERNS.reminder, category: INTENT_CATEGORIES.TASK_REMINDER },
      { patterns: DEEP_PATTERNS.event, category: INTENT_CATEGORIES.TASK_EVENT },
      { patterns: DEEP_PATTERNS.note, category: INTENT_CATEGORIES.TASK_NOTE },
      { patterns: DEEP_PATTERNS.search, category: INTENT_CATEGORIES.TASK_SEARCH },
      { patterns: DEEP_PATTERNS.planning, category: INTENT_CATEGORIES.TASK_PLANNING },
      { patterns: DEEP_PATTERNS.goal, category: INTENT_CATEGORIES.TASK_GOAL },
      { patterns: DEEP_PATTERNS.project, category: INTENT_CATEGORIES.TASK_PROJECT },
      { patterns: DEEP_PATTERNS.analysis, category: INTENT_CATEGORIES.TASK_PLANNING },
      { patterns: DEEP_PATTERNS.purchase, category: INTENT_CATEGORIES.TASK_PLANNING },
    ];

    for (const check of deepChecks) {
      for (const pattern of check.patterns) {
        if (pattern.test(lower)) {
          category = check.category;
          confidence = 0.85;
          reason = 'deep pattern: ' + check.category;
          break;
        }
      }
      if (category !== INTENT_CATEGORIES.UNKNOWN) break;
    }
  }

  // ── Step 3: Heuristic detection ───────────────────────────────────────
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    // Question detection
    if (questionCount >= 1) {
      const howToPatterns = /how\s*(to|do|can|should|could)|macam\s*mana|bagaimana|cara\s*(nak|untuk|buat)/i;
      const opinionPatterns = /what\s*do\s*you\s*think|pendapat|opinion|what('?s| is) your|apa\s*pendapat/i;

      if (howToPatterns.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_HOWTO;
        confidence = 0.8;
        reason = 'how-to question';
      } else if (opinionPatterns.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_OPINION;
        confidence = 0.75;
        reason = 'opinion question';
      } else {
        category = INTENT_CATEGORIES.QUESTION_FACT;
        confidence = 0.7;
        reason = 'general question';
      }
    }
    // Long messages with multiple sentences → likely deep
    else if (wordCount > 30) {
      category = INTENT_CATEGORIES.TASK_PLANNING;
      confidence = 0.7;
      reason = 'long complex message';
    } else if (questionCount >= 3) {
      category = INTENT_CATEGORIES.TASK_PLANNING;
      confidence = 0.75;
      reason = 'multiple questions';
    }
    // Default: conversation
    else {
      category = INTENT_CATEGORIES.CONVERSATION;
      confidence = 0.6;
      reason = 'casual conversation';
    }
  }

  // ── Step 4: Mood detection ────────────────────────────────────────────
  const { mood, confidence: moodConfidence } = detectMood(lower);

  // ── Step 5: Urgency detection ─────────────────────────────────────────
  const { isUrgent, confidence: urgencyConfidence } = detectUrgency(lower);

  // ── Step 6: Language detection ────────────────────────────────────────
  const { language } = detectLanguage(text);

  // ── Step 7: Determine tier ────────────────────────────────────────────
  const fastCategories = [INTENT_CATEGORIES.GREETING, INTENT_CATEGORIES.FEEDBACK];
  const deepCategories = [
    INTENT_CATEGORIES.TASK_REMINDER, INTENT_CATEGORIES.TASK_EVENT,
    INTENT_CATEGORIES.TASK_NOTE, INTENT_CATEGORIES.TASK_SEARCH,
    INTENT_CATEGORIES.TASK_PLANNING, INTENT_CATEGORIES.TASK_GOAL,
    INTENT_CATEGORIES.TASK_PROJECT, INTENT_CATEGORIES.TASK_MEMORY,
  ];

  let tier;
  if (fastCategories.includes(category)) {
    tier = 'fast';
  } else if (deepCategories.includes(category)) {
    tier = 'deep';
  } else if (isUrgent && urgencyConfidence > 0.7) {
    tier = 'deep';
    reason += ' (urgent)';
    category = INTENT_CATEGORIES.EMERGENCY;
  } else {
    tier = 'medium';
  }

  // ── Fast-tier override: simple time/date queries and bot identity ─────
  if (tier === 'medium' && category === INTENT_CATEGORIES.QUESTION_FACT) {
    if (reason === 'time/date query' || reason === 'bot identity question') {
      tier = 'fast';
    }
  }

  // ── Step 8: Context-aware escalation ──────────────────────────────────
  let needsEscalation = false;
  let escalationReason = '';

  if (context.workingMemory && context.workingMemory.currentGoal) {
    const wm = context.workingMemory;
    const goalWords = [wm.currentGoal, wm.currentProblem]
      .filter(Boolean)
      .flatMap(s => s.toLowerCase().split(/\s+/));
    const overlap = goalWords.filter(w => lower.includes(w)).length;

    if (overlap >= 2 && tier === 'medium') {
      needsEscalation = true;
      escalationReason = 'mid-task continuation (goal: ' + wm.currentGoal.slice(0, 50) + ')';
    }
  }

  // Check continuation signals
  if (context.recentMessages && context.recentMessages.length > 0) {
    const lastMsg = (context.recentMessages[context.recentMessages.length - 1] || '').toLowerCase();
    const isContinuation = CONTINUATION_SIGNALS.some(s => new RegExp('\\b' + s + '\\b', 'i').test(lower));
    if (isContinuation && tier !== 'deep') {
      needsEscalation = true;
      escalationReason = 'continuation signal after previous message';
    }
  }

  // ── Step 9: Sub-category refinement ───────────────────────────────────
  let subCategory = '';

  if (category === INTENT_CATEGORIES.TASK_REMINDER) {
    if (/\b(cancel|batalkan|padam|delete|buang|remove)\b/i.test(lower)) subCategory = 'cancel';
    else if (/\b(edit|ubah|tukar|update|kemaskini)\b/i.test(lower)) subCategory = 'update';
    else if (/\b(list|senarai|show|tunjuk|apa\s*ada)\b/i.test(lower)) subCategory = 'list';
    else subCategory = 'create';
  }

  if (category === INTENT_CATEGORIES.TASK_NOTE) {
    if (/\b(list|senarai|show|tunjuk|baca|read)\b/i.test(lower)) subCategory = 'list';
    else subCategory = 'create';
  }

  if (category === INTENT_CATEGORIES.TASK_SEARCH) {
    if (/\b(berita|news)\b/i.test(lower)) subCategory = 'news';
    else if (/\b(harga|price|kos|cost)\b/i.test(lower)) subCategory = 'price';
    else subCategory = 'general';
  }

  return {
    tier,
    category,
    subCategory,
    confidence,
    mood,
    moodConfidence,
    isUrgent,
    urgencyConfidence,
    language,
    reason,
    needsEscalation,
    escalationReason,
  };
}

// ── Quick intent detection (backward compatible) ───────────────────────────
function detectIntent(text) {
  const result = detectIntentAdvanced(text);
  let provider = 'mimo';
  if (result.tier === 'deep') provider = 'deepseek';
  return {
    tier: result.tier,
    provider,
    reason: result.reason,
    category: result.category,
    confidence: result.confidence,
  };
}

module.exports = {
  detectIntent,
  detectIntentAdvanced,
  detectMood,
  detectUrgency,
  detectLanguage,
  INTENT_CATEGORIES,
};
