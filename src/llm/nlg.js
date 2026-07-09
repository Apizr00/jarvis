// src/llm/nlg.js
// ── Natural Language Generation Enhancer ──────────────────────────────────────
//
// Post-processes LLM responses to improve quality before sending to user.
// All functions are PURE — text in, better text out. No async, no DB.
//
// Capabilities:
//   - Fix common LLM patterns (repetition, verbosity, formatting)
//   - Language consistency (match user's language)
//   - Readability improvements (sentence splitting, markdown cleanup)
//   - Personality injection (add warmth, remove robotic tone)
//   - Clarity boost (remove hedging when confident, add hedging when unsure)

// ═══════════════════════════════════════════════════════════════════════════════
// 1. REPETITION & VERBOSITY FIXES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Remove repeated sentences/phrases (LLMs often repeat themselves).
 */
function removeRepetition(text) {
  if (!text || text.length < 50) return text;

  const sentences = text.split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const unique = [];

  for (const s of sentences) {
    const normalized = s.toLowerCase().replace(/[^\w\s]/g, '').trim();
    if (!seen.has(normalized) && normalized.length > 5) {
      seen.add(normalized);
      unique.push(s);
    }
  }

  return unique.join(' ');
}

/**
 * Remove excessive hedging that makes the bot sound uncertain.
 * Keep SOME hedging for genuinely uncertain statements.
 */
function reduceExcessiveHedging(text) {
  if (!text) return text;

  // Remove redundant hedging pairs
  const hedges = [
    [/\bI think perhaps maybe\b/gi, 'Perhaps'],
    [/\bI'm not entirely sure, but I think\b/gi, 'I believe'],
    [/\bmight possibly maybe\b/gi, 'might'],
    [/\b(?:saya rasa mungkin|mungkin saya rasa)\b/gi, 'Mungkin'],
    [/\b(?:tak pasti tapi rasanya|rasanya tak pasti)\b/gi, 'Rasanya'],
  ];

  let result = text;
  for (const [pattern, replacement] of hedges) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Trim overly verbose introductions/conclusions.
 */
function trimVerbosity(text) {
  if (!text || text.length < 100) return text;

  // Remove common LLM filler phrases at the start
  const startFillers = [
    /^(Sure!|Of course!|Absolutely!|Certainly!|Great question!|I'd be happy to help[^.]*\.)\s*/i,
    /^(Baiklah!|Tentu!|Boleh!|OK!)\s*/i,
  ];

  let result = text;
  for (const filler of startFillers) {
    result = result.replace(filler, '');
  }

  // Remove common LLM filler at the end
  const endFillers = [
    /\s*(Let me know if you need (?:anything|help|more|further)[^.]*\.?)$/i,
    /\s*(I hope this helps[^.]*\.?)$/i,
    /\s*(Jangan (?:segan|malu)[^.]*\.?)$/i,
    /\s*(Harap (?:membantu|berguna)[^.]*\.?)$/i,
  ];

  for (const filler of endFillers) {
    result = result.replace(filler, '');
  }

  return result.trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. LANGUAGE CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect the primary language of a text.
 * Returns 'en', 'ms', or 'rojak'.
 */
function detectLanguage(text) {
  if (!text) return 'en';

  const malayMarkers = /\b(?:aku|saya|awak|kau|nak|tak|dah|ni|tu|lah|kan|pun|je|ni|tu|bolehlah|kat|dekat|sebab|kerana|ialah|adalah|ini|itu|sangat|sahaja|sahaja|pun|lagi|pula|memang|memang|paling|antara|bagi|untuk|dengan|daripada|kepada|pada|akan|telah|sedang|belum|sudah|masih|boleh|dapat|mesti|perlu|patut|mahu|nak|ingin|suka|minat|tahu|faham|nampak|dengar|rasa|cakap|kata|bagi|beri|ambil|buat|pergi|datang|masuk|keluar|naik|turun|makan|minum|tidur|bangun|mandi|kerja|belajar|main|baca|tulis|duduk|jalan|lari|tengok|lihat|fikir|ingat|lupe)\b/i;
  const englishMarkers = /\b(?:the|is|are|was|were|have|has|had|can|could|will|would|shall|should|may|might|must|this|that|these|those|with|from|about|into|through|during|before|after|above|below|between)\b/i;

  const malayCount = (text.match(malayMarkers) || []).length;
  const englishCount = (text.match(englishMarkers) || []).length;
  const total = malayCount + englishCount;

  if (total === 0) return 'en';
  if (malayCount > englishCount * 2) return 'ms';
  if (englishCount > malayCount * 2) return 'en';
  if (malayCount > 0 && englishCount > 0) return 'rojak';
  return 'en';
}

/**
 * Fix language switching within a response.
 * If user wrote in BM, the entire response should stay BM.
 */
function enforceLanguageConsistency(text, userLanguage) {
  if (!text || !userLanguage || userLanguage === 'rojak') return text;

  if (userLanguage === 'ms') {
    // Replace common English remnants with Malay
    const enToMs = [
      [/\b(okay|ok)\b/gi, 'baik'],
      [/\b(sure)\b/gi, 'pasti'],
      [/\b(please)\b/gi, 'sila'],
      [/\b(sorry)\b/gi, 'maaf'],
      [/\b(thanks?|thank you)\b/gi, 'terima kasih'],
      [/\b(great|awesome|nice)\b/gi, 'bagus'],
      [/\b(hello|hi|hey)\b/gi, 'hai'],
      [/\b(goodbye|bye)\b/gi, 'jumpa lagi'],
    ];

    let result = text;
    for (const [pattern, replacement] of enToMs) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  return text;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. READABILITY IMPROVEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Split very long paragraphs for better readability on mobile.
 */
function improveReadability(text) {
  if (!text || text.length < 150) return text;

  let result = text;

  // Split sentences that are too long (>200 chars without punctuation)
  result = result.replace(/(.{150,}?)\s+(?=[a-z])/g, '$1\n');

  // Ensure bullet points have proper formatting
  result = result.replace(/^[•\-]\s*/gm, '• ');
  result = result.replace(/^(\d+)[.)]\s*/gm, '$1. ');

  // Remove excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

/**
 * Clean up common markdown issues.
 */
function cleanMarkdown(text) {
  if (!text) return text;

  let result = text;

  // Fix unbalanced bold/italic
  const boldCount = (result.match(/\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    // Remove the last unpaired *
    result = result.replace(/\*(?!.*\*)/, '');
  }

  // Fix double escaping
  result = result.replace(/\\\\/g, '\\');

  // Remove trailing whitespace from each line
  result = result.split('\n').map(l => l.trimRight()).join('\n');

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PERSONALITY INJECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject personality into a bot response based on configured profile.
 *
 * @param {string} text — raw response
 * @param {string} personality — from DB config (e.g., "friendly and helpful in rojak language")
 * @returns {string}
 */
function injectPersonality(text, personality) {
  if (!text || !personality) return text;

  const lower = personality.toLowerCase();
  let result = text;

  // Friendly tone
  if (/\b(friendly|mesra|ramah|warm)\b/i.test(lower)) {
    // Add warmth to very short responses
    if (result.length < 30 && !/[😊🙂😄]/u.test(result)) {
      result += ' 😊';
    }
  }

  // Humorous
  if (/\b(humor|funny|lawak|kelakar|sarcastic)\b/i.test(lower)) {
    // Occasionally add a light touch (10% chance is hard to do deterministically, skip for now)
  }

  // Professional
  if (/\b(professional|formal|profesional)\b/i.test(lower)) {
    // Replace casual contractions
    result = result.replace(/\b(don't)\b/gi, 'do not');
    result = result.replace(/\b(can't)\b/gi, 'cannot');
    result = result.replace(/\b(it's)\b/gi, 'it is');
  }

  // Concise
  if (/\b(concise|ringkas|pendek|short|brief|padat)\b/i.test(lower)) {
    // Truncate very long responses
    if (result.length > 500) {
      const sentences = result.split(/(?<=[.!?])\s+/);
      result = sentences.slice(0, Math.ceil(sentences.length * 0.6)).join(' ');
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CLARITY BOOST
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Add confidence markers to clear statements, and hedging to uncertain ones.
 */
function boostClarity(text) {
  if (!text) return text;
  let result = text;

  // If the bot says "I don't know" or similar, make it clearer
  const uncertaintyPatterns = [
    /\b(I'?m not sure|I don'?t know|tak pasti|tak tahu|tidak pasti|entahlah)\b/i,
  ];

  for (const pattern of uncertaintyPatterns) {
    if (pattern.test(result)) {
      // Add a helpful follow-up
      if (!/\b(try|try asking|cuba|boleh tanya)\b/i.test(result)) {
        result += ' Boleh cuba tanya cara lain?';
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Full NLG enhancement pipeline.
 * Applies all improvements to a bot response before sending.
 *
 * @param {string} text — raw LLM response
 * @param {object} [options]
 * @param {string} [options.userLanguage] — 'en', 'ms', or 'rojak'
 * @param {string} [options.personality] — bot personality config
 * @param {boolean} [options.skipPersonality] — if true, skip personality injection
 * @returns {string} — enhanced response
 */
function enhance(text, options = {}) {
  if (!text || typeof text !== 'string') return text;

  let result = text;

  // Stage 1: Remove LLM artifacts
  result = removeRepetition(result);
  result = trimVerbosity(result);

  // Stage 2: Language consistency
  if (options.userLanguage) {
    result = enforceLanguageConsistency(result, options.userLanguage);
  }

  // Stage 3: Readability
  result = improveReadability(result);
  result = cleanMarkdown(result);

  // Stage 4: Clarity
  result = reduceExcessiveHedging(result);
  result = boostClarity(result);

  // Stage 5: Personality (optional)
  if (!options.skipPersonality && options.personality) {
    result = injectPersonality(result, options.personality);
  }

  return result;
}

/**
 * Quick enhancement (lightweight, for fast-tier responses).
 */
function enhanceQuick(text) {
  if (!text) return text;
  let result = text;
  result = cleanMarkdown(result);
  result = trimVerbosity(result);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  enhance,
  enhanceQuick,
  removeRepetition,
  trimVerbosity,
  reduceExcessiveHedging,
  enforceLanguageConsistency,
  detectLanguage,
  improveReadability,
  cleanMarkdown,
  injectPersonality,
  boostClarity,
};
