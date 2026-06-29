// src/llm/intent.js
// ── Fast Intent Detection ───────────────────────────────────────────────────
// Keyword-based intent classifier. Runs in <1ms — no LLM call needed.
// Routes user messages into tiers: fast, medium, deep.
//
// Tiers:
//   fast    — greeting, simple question, no memory/tools needed
//   medium  — info request, conversation, needs basic context
//   deep    — task, planning, tool execution, multi-step

// ── Fast Tier (greetings, simple pleasantries, basic questions) ──────────
const FAST_PATTERNS = [
  // Greetings
  /^(hi|hello|hey|hai|helo|selamat\s*(pagi|petang|malam|tengahari)|assalam|salam|yo|sup|what's\s*up|wsup)\b/i,
  /^(apa\s*khabar|how\s*are\s*you|how's\s*it\s*going|howdy)\b/i,
  /^(ok|okay|baik|baiklah|alright|fine|bagus)\b/i,
  // Gratitude / acknowledgment
  /^(thanks|thank\s*you|terima\s*kasih|tq|thx|ty|makasih|good\s*(job|bot)|nice|great|awesome)\b/i,
  /^(bye|goodbye|bai|jumpa|see\s*you|night|selamat\s*malam|good\s*night)\b/i,
  // Simple time/date
  /^(pukul\s*berapa|jam\s*berapa|what\s*time|time\s*now|current\s*time|time\s*check)\b/i,
  /^(hari\s*apa|what\s*day|today\s*date|tarikh|hari\s*ni\s*apa)\b/i,
  /^(sekarang\s*(pukul|jam|hari|tarikh))\b/i,
  // Simple bot questions
  /^(nama\s*(awak|ko|kau|bot)|what('?s| is) your name|who are you|siapa\s*(awak|ko|kau|nama))\b/i,
  /^(boleh\s*(buat|tolong)\s*apa|what can you do|apa\s*(function|fungsi|boleh\s*buat))\b/i,
];

// ── Deep Tier (tasks, tools, planning, multi-step) ────────────────────────
const DEEP_PATTERNS = [
  // Reminders & scheduling
  /ingatkan|remind(er)?|peringatan|notify|notification|alarm/i,
  /jadual|schedule|kalendar|calendar|event|temujanji|appointment/i,
  /setkan|set\s*(up|kan)|buatkan|create|add|tambah/i,
  // Tasks & goals
  /task|tugasan|tugas|goal|matlamat|target|sasaran|project|projek/i,
  /sambung\s*(projek|kerja|task|buat)|continue/i,
  /plan|rancang|planning|strategy|strategi|roadmap/i,
  // Explicit tool triggers
  /(simpan|save|ingat|remember)\s*(nota|note|fact|fakta|info|maklumat)/i,
  /(cari|search|google)\s*(dalam|online|internet|google|web|berita|news|terkini|untuk|tentang|about|for)?/i,
  /(delete|padam|buang|remove|cancel|batalkan)\s*(reminder|event|task|nota|note)/i,
  // Deep analysis requests
  /analisis|analisa|analy(s|z)e|breakdown|bandingkan|compare/i,
  /suggest|cadang|recommend|syor|nasihat\s*(apa|macam)/i,
  /berapa\s*(kos|harga|budget|cost|price)|estimate|anggar/i,
  // Purchase & decisions (involve planning, budget, comparison)
  /\b(beli|nak\s*beli|buy|purchase|membeli)\b/i,
  // Complex decision making
  /patut\s*(ke|tak)|should\s*i|advisable|sesuai\s*ke|baik\s*mana|which\s*(is |one)/i,
  // Multi-step / project
  /step|langkah|process|proses|workflow|tutorial|guide|panduan/i,
];

// ── Intent Classification ───────────────────────────────────────────────────

/**
 * Detect user intent tier from message text.
 * Returns a tier and the preferred provider for that tier.
 *
 * @param {string} text - user's message
 * @returns {{tier: 'fast'|'medium'|'deep', provider: 'mimo'|'deepseek', reason: string}}
 */
function detectIntent(text) {
  if (!text || typeof text !== 'string') {
    return { tier: 'medium', provider: 'mimo', reason: 'empty message' };
  }

  const lower = text.toLowerCase().trim();

  // ── Check fast patterns first ──────────────────────────────────────────
  for (const pattern of FAST_PATTERNS) {
    if (pattern.test(lower)) {
      return { tier: 'fast', provider: 'mimo', reason: 'greeting/simple question' };
    }
  }

  // ── Check deep patterns ────────────────────────────────────────────────
  for (const pattern of DEEP_PATTERNS) {
    if (pattern.test(lower)) {
      return { tier: 'deep', provider: 'deepseek', reason: 'task/planning/tool' };
    }
  }

  // ── Heuristics for deep ────────────────────────────────────────────────
  // Long, complex messages → likely deep
  const wordCount = lower.split(/\s+/).length;
  if (wordCount > 25) {
    return { tier: 'deep', provider: 'deepseek', reason: 'long complex message' };
  }

  // Multiple questions → deep
  const questionCount = (lower.match(/\?/g) || []).length;
  if (questionCount >= 3) {
    return { tier: 'deep', provider: 'deepseek', reason: 'multiple questions' };
  }

  // ── Default: medium ────────────────────────────────────────────────────
  return { tier: 'medium', provider: 'mimo', reason: 'conversational' };
}

module.exports = { detectIntent, FAST_PATTERNS, DEEP_PATTERNS };
