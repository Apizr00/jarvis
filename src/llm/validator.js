// src/llm/validator.js
// Anti-hallucination validator — catches LLM lies before they reach the user
const { dayjs, fmt } = require('../utils/datetime');

/**
 * Action verbs that STRONGLY indicate the bot claims to have done something.
 * These are verbs used in PAST TENSE or PERFECT form claiming completion.
 * We deliberately EXCLUDE present/future tense and common conversational uses.
 */
const ACTION_VERBS = [
  // English — only past tense / perfect forms that claim completion
  "i've created", "i've set", "i've saved", "i've added", "i've updated",
  "i've cancelled", "i've deleted", "i've removed", "i've changed", "i've recorded",
  "i have created", "i have set", "i have saved", "i have added",
  "i have cancelled", "i have deleted", "i have noted",
  "i will remind", "i will create", "i will set", "i will save",
  "i'll remind", "i'll create", "i'll set", "i'll save",
  "reminder set", "reminder created", "reminder saved",
  "event created", "event added", "event set",
  "note saved", "note added", "note recorded",
  "task created", "task added",
  "goal created", "goal set",
  "all set!", "got it!",
  // Malay/Indonesian — past tense claims
  'dah set', 'dah create', 'dah tambah', 'dah save', 'dah update', 'dah cancel',
  'dah delete', 'dah buang', 'dah tukar', 'dah ubah', 'dah rekod',
  'dah simpan', 'dah jadual', 'dah schedule', 'dah siap', 'dah settle',
  'sudah set', 'sudah create', 'sudah tambah', 'sudah save', 'sudah cancel',
  'sudah delete', 'sudah tukar', 'telah set', 'telah create', 'telah tambah',
  'telah save', 'telah cancel', 'akan set', 'akan create', 'akan tambah',
  'akan ingatkan', 'siap dah', 'okay dah', 'setkan', 'tambahkan',
  'simpankan', 'recordkan', 'cancelkan', 'deletekan',
];

/**
 * Phrases that indicate confirmation of an action the bot claims to have done.
 * These are red flags in a message-type response.
 * Narrowed to only include CLEAR completion/confirmation claims.
 */
const CONFIRMATION_PHRASES = [
  // English — only clear action completion claims
  "i've created", "i've set", "i've saved", "i've added",
  "i've cancelled", "i've deleted", "i've updated",
  "i have created", "i have set", "i have saved",
  "i just created", "i just set", "i just saved",
  "reminder set!", "reminder created!", "reminder saved!",
  "event added!", "event created!",
  "note saved!", "note added!",
  "task created!", "goal created!",
  "done! reminder", "done! event", "done! note",
  "created your", "saved your", "updated your",
  "cancelled your", "deleted your", "removed your",
  "changed your", "scheduled for you",
  // Malay — only clear completion claims
  "dah siap", "dah settle", "dah okay", "okay dah", "siap dah",
  "reminder dah set", "reminder dah create", "event dah tambah",
  "note dah save", "dah save note", "dah cancel reminder",
  "dah set reminder", "dah create reminder", "dah tambah event",
];

/**
 * Detect if a message-type LLM response contains hallucinated action claims.
 * Now with stricter thresholds to avoid false positives on normal conversation.
 * 
 * @param {string} content - the LLM's message content
 * @returns {{isHallucination: boolean, reason?: string, confidence: number}}
 */
function detectActionHallucination(content) {
  if (!content || typeof content !== 'string') {
    return { isHallucination: false, confidence: 0 };
  }

  const lower = content.toLowerCase();
  let confidence = 0;
  let reasons = [];
  let categoriesHit = 0; // Require at least 2 categories for a hit

  // Category 1: Action verbs (past tense / completion claims)
  let verbHit = false;
  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb)) {
      confidence += 0.4;
      reasons.push('contains action verb: "' + verb + '"');
      verbHit = true;
      break; // One verb is enough — prevent stacking from similar words
    }
  }
  if (verbHit) categoriesHit++;

  // Category 2: Confirmation phrases
  let phraseHit = false;
  for (const phrase of CONFIRMATION_PHRASES) {
    if (lower.includes(phrase)) {
      confidence += 0.4;
      reasons.push('contains confirmation phrase: "' + phrase + '"');
      phraseHit = true;
      break;
    }
  }
  if (phraseHit) categoriesHit++;

  // Category 3: Starts with confirmation emoji/word AND followed by action context
  const startMatch = content.trim().match(/^(✅|✓|☑|🎉)/);
  if (startMatch) {
    // Only flag if there's also action-related content after the emoji
    const afterEmoji = content.trim().slice(startMatch[0].length).toLowerCase();
    const hasActionAfterEmoji = ACTION_VERBS.some(v => afterEmoji.includes(v)) ||
      CONFIRMATION_PHRASES.some(p => afterEmoji.includes(p));
    if (hasActionAfterEmoji) {
      confidence += 0.3;
      reasons.push('starts with confirmation emoji + action language');
      categoriesHit++;
    }
  }

  // Category 4: Object word near an action verb (but only if verb/phrase already found)
  if (verbHit || phraseHit) {
    const objectWords = ['reminder', 'event', 'task', 'note', 'goal', 'alarm', 'notification'];
    for (const obj of objectWords) {
      if (lower.includes(obj)) {
        const hasActionNearby = ACTION_VERBS.some(verb => {
          const objIndex = lower.indexOf(obj);
          const verbIndex = lower.indexOf(verb);
          return verbIndex !== -1 && Math.abs(objIndex - verbIndex) < 50;
        });
        if (hasActionNearby) {
          confidence += 0.2;
          reasons.push('object word "' + obj + '" near action verb');
          categoriesHit++;
          break;
        }
      }
    }
  }

  // Require at least 2 categories AND confidence >= 0.7 to flag as hallucination
  const isHallucination = categoriesHit >= 2 && confidence >= 0.7;

  return {
    isHallucination,
    confidence,
    reason: isHallucination ? reasons.join(', ') : undefined,
  };
}

/**
 * Detect time hallucinations in the message.
 * Returns all mismatched times found.
 * 
 * @param {string} content - the message content
 * @param {string} timezone - user's timezone
 * @returns {{hasTimeHallucination: boolean, wrongTimes: Array<string>}}
 */
function detectTimeHallucination(content, timezone = 'UTC') {
  if (!content || typeof content !== 'string') {
    return { hasTimeHallucination: false, wrongTimes: [] };
  }

  const now = new Date();
  const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now), 10);
  const minute = parseInt(new Intl.DateTimeFormat('en', { timeZone: timezone, minute: '2-digit' }).format(now), 10);
  const actualTotalMins = hour * 60 + minute;

  const wrongTimes = [];
  const timePattern = /(pukul|jam|dah\s+(?:pukul|jam)\s+|around\s+|about\s+|at\s+|it'?s?\s+|is\s+|now\s+|already\s+)?(\d{1,2})[:.](\d{2})(?!\d)\s*(pagi|am|a\.m\.?|petang|malam|pm|p\.m\.?)?/gi;

  let match;
  while ((match = timePattern.exec(content)) !== null) {
    const matchedHour = parseInt(match[2], 10);
    const matchedMinute = parseInt(match[3], 10);
    const period = (match[4] || '').toLowerCase();

    // Convert to 24h
    let matched24h = matchedHour;
    if (/(petang|malam|pm|p\.m)/i.test(period)) {
      if (matchedHour !== 12) matched24h = matchedHour + 12;
    } else if (/(pagi|am|a\.m)/i.test(period)) {
      if (matchedHour === 12) matched24h = 0;
    }

    const matchedTotalMins = matched24h * 60 + matchedMinute;
    const diffMins = Math.abs(matchedTotalMins - actualTotalMins);

    // If more than 2 minutes off AND it looks like a CURRENT time reference, it's wrong.
    // Future/past references like "remind at 12:30" or "tadi pukul 3" should NOT be flagged.
    if (diffMins > 2) {
      const prefix = (match[1] || '').toLowerCase();
      const fullMatch = match[0];

      // ── Check broader context (80 chars before) for future/past indicators ──
      const before = content.substring(Math.max(0, match.index - 80), match.index).toLowerCase();

      // Future-reference keywords — any of these in the 80-char window means skip
      const futureKeywords = /\b(?:at|nanti|remind|akan|pada|around|about|by|before|until|hingga|sampai|dalam|lagi|next|esok|tomorrow|lusa|minggu|bulan|ingatkan|remind(?:er)?|event|jadual|schedule|meeting|set(?:kan)?|buat(?:kan)?|create|add|tambah|balik\s*kerja|pulang|keluar|masuk|kelas|meeting|appointment|temujanji|nanti\s*(pukul|jam|kul)|pada\s*(pukul|jam|kul)|dalam\s*\d+\s*(minit|jam|hari))\b/i;

      // Past-reference keywords
      const pastKeywords = /\b(?:tadi|was|earlier|semalam|kelmarin|yesterday|last|baru\s*(?:ni|tadi|saja)|sebentar\s*tadi)\b/i;

      // Check prefix for future/past
      const isFutureContext = futureKeywords.test(prefix) || futureKeywords.test(fullMatch);
      const isPastContext = pastKeywords.test(prefix);

      if (isFutureContext || isPastContext) {
        // Skip — this is a future/past event time, not a current time hallucination
        continue;
      }

      // For ambiguous cases, check the broader 80-char before context
      if (futureKeywords.test(before)) {
        continue; // future reference detected in surrounding text
      }
      if (pastKeywords.test(before)) {
        continue; // past reference detected in surrounding text
      }

      // ── Additional guard: if the message is clearly a CONFIRMATION of setting
      // a future reminder, don't flag the time ──
      const afterContext = content.substring(match.index, match.index + 60).toLowerCase();
      if (/(?:nanti|akan|ingatkan|remind|set|dah\s*set|dah\s*create)/i.test(afterContext)) {
        continue;
      }

      wrongTimes.push(match[0]);
    }
  }

  // Detect CRITICAL error: mentions of "tinggal X minit" or "X minutes left" with wrong calculations
  // Pattern 1: "pukul 12:30... pukul 12:30— tinggal 9 minit" (same time, says X minutes left)
  const timeLeftPattern = /tinggal\s+(\d+)\s*minit|(\d+)\s*minit\s+(?:je\s+)?lagi|(\d+)\s*minutes?\s+left/gi;
  let timeLeftMatch;
  while ((timeLeftMatch = timeLeftPattern.exec(content)) !== null) {
    const minsLeft = parseInt(timeLeftMatch[1] || timeLeftMatch[2] || timeLeftMatch[3], 10);

    // If it mentions significant time left (>3 minutes), check if it makes sense
    if (minsLeft >= 3) {
      // Extract all times mentioned in the message
      const allTimesMentioned = [];
      const allTimesPattern = /(\d{1,2})[:.](\d{2})\s*(AM|PM|am|pm)?/gi;
      let timeMatch;
      while ((timeMatch = allTimesPattern.exec(content)) !== null) {
        const h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        const per = (timeMatch[3] || '').toLowerCase();
        let h24 = h;
        if (per === 'pm' && h !== 12) h24 = h + 12;
        if (per === 'am' && h === 12) h24 = 0;
        allTimesMentioned.push(h24 * 60 + m);
      }

      // If all mentioned times are close to current time (within 3 minutes), saying "X minutes left" is wrong
      const allTimesCloseToNow = allTimesMentioned.every(t => Math.abs(t - actualTotalMins) <= 3);
      if (allTimesCloseToNow && minsLeft >= 3) {
        wrongTimes.push('incorrect time calculation: says "' + minsLeft + ' minutes left" but times are same/close');
      }
    }
  }

  // Pattern 2: "dah lepas X minit" (already passed by X minutes) with wrong calculations
  const passedPattern = /dah\s+lepas\s+(\d+)\s*minit|passed\s+(?:by\s+)?(\d+)\s*minutes?|(\d+)\s*minit\s+dah/gi;
  let passedMatch;
  while ((passedMatch = passedPattern.exec(content)) !== null) {
    const minsPassed = parseInt(passedMatch[1] || passedMatch[2] || passedMatch[3], 10);

    // Similar check: if times mentioned are close to current time, saying "passed by X minutes" is wrong
    if (minsPassed >= 3) {
      const allTimesMentioned = [];
      const allTimesPattern = /(\d{1,2})[:.](\d{2})\s*(AM|PM|am|pm)?/gi;
      let timeMatch;
      while ((timeMatch = allTimesPattern.exec(content)) !== null) {
        const h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        const per = (timeMatch[3] || '').toLowerCase();
        let h24 = h;
        if (per === 'pm' && h !== 12) h24 = h + 12;
        if (per === 'am' && h === 12) h24 = 0;
        allTimesMentioned.push(h24 * 60 + m);
      }

      const allTimesCloseToNow = allTimesMentioned.every(t => Math.abs(t - actualTotalMins) <= 3);
      if (allTimesCloseToNow && minsPassed >= 3) {
        wrongTimes.push('incorrect time calculation: says "passed by ' + minsPassed + ' minutes" but times are same/close');
      }
    }
  }

  // Pattern 3: Detect if bot mentions "minutes left/passed" with obviously wrong math
  // E.g., "pukul 12:30... pukul 12:30— tinggal 9 minit" (same times but says 9 min left)
  const obviouslyWrongPattern = /(12:\d{2}|1:\d{2}|2:\d{2}|3:\d{2}|4:\d{2}|5:\d{2}|6:\d{2}|7:\d{2}|8:\d{2}|9:\d{2}|10:\d{2}|11:\d{2})[^0-9]{0,50}(12:\d{2}|1:\d{2}|2:\d{2}|3:\d{2}|4:\d{2}|5:\d{2}|6:\d{2}|7:\d{2}|8:\d{2}|9:\d{2}|10:\d{2}|11:\d{2})[^0-9]{0,50}(tinggal|left|lepas|passed)\s+(\d+)\s*(minit|minute)/i;
  const obviousMatch = content.match(obviouslyWrongPattern);
  if (obviousMatch) {
    const time1 = obviousMatch[1];
    const time2 = obviousMatch[2];
    const mins = parseInt(obviousMatch[4], 10);
    // If both times are similar (same hour) but claims >5 minutes difference, flag it
    if (time1.split(':')[0] === time2.split(':')[0] && mins >= 5) {
      wrongTimes.push('nonsensical time math: mentions similar times but claims ' + mins + ' minutes difference');
    }
  }

  return {
    hasTimeHallucination: wrongTimes.length > 0,
    wrongTimes,
  };
}

/**
 * Detect if LLM is making up facts not in the provided context.
 * 
 * @param {string} content - the message content
 * @param {Array<{key:string, value:string}>} userFacts - facts that were provided to the LLM
 * @returns {{hasFactHallucination: boolean, suspiciousClaims: Array<string>}}
 */
function detectFactHallucination(content, userFacts = []) {
  if (!content || typeof content !== 'string') {
    return { hasFactHallucination: false, suspiciousClaims: [] };
  }

  const suspiciousClaims = [];
  const lower = content.toLowerCase();

  // Phrases that indicate the bot is stating a fact about the user
  const factPhrases = [
    'you said', 'you mentioned', 'you told me', 'you prefer', 'your favorite',
    'you usually', 'you always', 'you like', 'you love', 'you hate',
    'you work at', 'you live in', 'your job', 'your hobby', 'your routine',
    'kau cakap', 'kau kata', 'kau suka', 'kau prefer', 'kau kerja',
    'kau duduk', 'kau selalu', 'kau biasa', 'kebiasaan kau',
  ];

  for (const phrase of factPhrases) {
    if (lower.includes(phrase)) {
      // Extract the sentence containing this phrase
      const sentences = content.split(/[.!?]/);
      const matchingSentence = sentences.find(s => s.toLowerCase().includes(phrase));

      if (matchingSentence) {
        // Check if this claim is backed by any user fact
        const isBacked = userFacts.some(fact => {
          const factLower = (fact.key + ' ' + fact.value).toLowerCase();
          // Extract key words from the sentence
          const words = matchingSentence.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          // If at least 2 words match the fact, consider it backed
          const matchCount = words.filter(w => factLower.includes(w)).length;
          return matchCount >= 2;
        });

        if (!isBacked) {
          suspiciousClaims.push(matchingSentence.trim());
        }
      }
    }
  }

  return {
    hasFactHallucination: suspiciousClaims.length > 0,
    suspiciousClaims,
  };
}

/**
 * Helper: check a single mentioned reminder against DB records.
 */
function checkReminderMatch(mentionedId, mentionedText, mentionedTime, mentionedPeriod, upcomingReminders, fabricatedReminders) {
  const actualReminder = upcomingReminders.find(r => r.id === mentionedId);

  if (actualReminder) {
    if (mentionedTime) {
      const actualDate = new Date(actualReminder.remind_at);
      const actualHour = actualDate.getHours();
      const actualMinute = actualDate.getMinutes();

      const timeParts = mentionedTime.split(/[:.]/);
      let mHour = parseInt(timeParts[0], 10);
      const mMinute = parseInt(timeParts[1], 10);

      if (/(pm|petang|malam)/i.test(mentionedPeriod)) {
        if (mHour !== 12) mHour += 12;
      } else if (/(am|pagi)/i.test(mentionedPeriod)) {
        if (mHour === 12) mHour = 0;
      }

      const timeMatches = mHour === actualHour && Math.abs(mMinute - actualMinute) <= 1;

      if (!timeMatches) {
        fabricatedReminders.push(
          '#' + mentionedId + ' "' + actualReminder.text + '" — ' +
          'LLM said ' + mentionedTime + ' ' + (mentionedPeriod || '') +
          ' but actual is ' + String(actualHour).padStart(2, '0') + ':' + String(actualMinute).padStart(2, '0')
        );
      }
    }

    const textWords = mentionedText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const actualTextLower = actualReminder.text.toLowerCase();
    const textOverlap = textWords.filter(w => actualTextLower.includes(w)).length;
    if (textWords.length >= 2 && textOverlap === 0) {
      fabricatedReminders.push(
        '#' + mentionedId + ' — LLM said "' + mentionedText.slice(0, 40) +
        '" but actual text is "' + actualReminder.text + '"'
      );
    }
  } else {
    fabricatedReminders.push(
      '#' + mentionedId + ' — this reminder ID does NOT exist in the database'
    );
  }
}

/**
 * Detect if LLM is fabricating reminder times (mentioning reminder IDs/texts
 * with times that don't match the actual DB reminders).
 * 
 * This is different from detectTimeHallucination — that checks against CURRENT time.
 * This checks against STORED reminder times in the database.
 * 
 * @param {string} content - the message content
 * @param {Array<{id:number, text:string, remind_at:string}>} upcomingReminders - actual reminders from DB
 * @returns {{hasFabrication: boolean, fabricatedReminders: Array<string>}}
 */
function detectReminderFabrication(content, upcomingReminders = []) {
  if (!content || typeof content !== 'string' || upcomingReminders.length === 0) {
    return { hasFabrication: false, fabricatedReminders: [] };
  }

  const fabricatedReminders = [];

  // ── Pattern A: "#ID - Text — time" format ─────────────────────────────
  // E.g., "#4 - Netherlands vs Morocco — pukul 6:36 am"
  const idPattern = /#(\d+)\s*[-–—]\s*(.+?)(?:\s*[-–—]\s*(?:pukul|jam|at)\s*(\d{1,2}[:.]\d{2})\s*(am|pm|pagi|petang|malam)?)?(?:\n|$)/gi;

  let match;
  while ((match = idPattern.exec(content)) !== null) {
    const mentionedId = parseInt(match[1], 10);
    const mentionedText = (match[2] || '').trim();
    const mentionedTime = match[3] || null;
    const mentionedPeriod = (match[4] || '').toLowerCase();

    checkReminderMatch(mentionedId, mentionedText, mentionedTime, mentionedPeriod, upcomingReminders, fabricatedReminders);
  }

  // ── Pattern B: Numbered list "1. Text — Date, Time" format ────────────
  // E.g., "1. Makan Malam — 29 Jun 2026, 7:15 pm"
  // This catches the LLM fabricating lists without using #IDs
  const numberedPattern = /(?:^|\n)\s*(\d+)\.\s+(.+?)\s*[-–—]\s*.+?(\d{1,2})[:.](\d{2})\s*(am|pm|AM|PM)/gi;

  while ((match = numberedPattern.exec(content)) !== null) {
    const mentionedText = (match[2] || '').trim();
    const mentionedHour = parseInt(match[3], 10);
    const mentionedMinute = parseInt(match[4], 10);
    const mentionedPeriod = (match[5] || '').toLowerCase();

    // Find matching reminder in DB by text similarity
    const textLower = mentionedText.toLowerCase();
    const bestMatch = upcomingReminders.find(r => {
      const rLower = r.text.toLowerCase();
      // Check for significant word overlap
      const words = textLower.split(/\s+/).filter(w => w.length > 2);
      const matchCount = words.filter(w => rLower.includes(w)).length;
      return matchCount >= Math.min(2, words.length); // at least 2 words or all if <2
    });

    if (bestMatch) {
      const actualDate = new Date(bestMatch.remind_at);
      const actualHour = actualDate.getHours();
      const actualMinute = actualDate.getMinutes();

      // Convert mentioned to 24h
      let m24h = mentionedHour;
      if (/(pm)/i.test(mentionedPeriod) && mentionedHour !== 12) m24h += 12;
      if (/(am)/i.test(mentionedPeriod) && mentionedHour === 12) m24h = 0;

      const timeMatches = m24h === actualHour && Math.abs(mentionedMinute - actualMinute) <= 1;

      if (!timeMatches) {
        fabricatedReminders.push(
          '"' + bestMatch.text + '" — LLM said ' + mentionedHour + ':' +
          String(mentionedMinute).padStart(2, '0') + ' ' + mentionedPeriod +
          ' but actual is ' + String(actualHour).padStart(2, '0') + ':' +
          String(actualMinute).padStart(2, '0')
        );
      }
    } else {
      // No matching reminder found — could be fabricated text
      // Only flag if the message clearly looks like it's listing reminders
      const lines = content.split('\n').filter(l => /\d+\.\s+.+[-–—].+/.test(l));
      if (lines.length >= 2) {
        fabricatedReminders.push(
          'Fabricated reminder list: "' + mentionedText.slice(0, 40) +
          '" doesn\'t match any actual reminder'
        );
      }
    }
  }

  // Also detect patterns like "#4 and #5" without explicit times but clearly fabricated
  // ONLY if the content also mentions reminder/time-related words (context check)
  if (fabricatedReminders.length === 0) {
    const hasReminderContext = /reminder|peringatan|ingatkan|pukul|jam|\btime\b|schedule|jadual|event/i.test(content);
    if (hasReminderContext) {
      const allHashIds = [...content.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
      const existingIds = new Set(upcomingReminders.map(r => r.id));
      const nonexistentIds = allHashIds.filter(id => !existingIds.has(id));

      // Only flag if 2+ nonexistent IDs (single mismatch could be innocent)
      if (nonexistentIds.length >= 2) {
        fabricatedReminders.push(
          'Mentioned reminder IDs that don\'t exist: ' + nonexistentIds.map(id => '#' + id).join(', ')
        );
      }
    }
  }

  return {
    hasFabrication: fabricatedReminders.length > 0,
    fabricatedReminders,
  };
}
/**
 * Detect if the user message is asking to CREATE/SET something (reminder, event, note).
 * Used to prevent the validator from forcing list_reminders when user wants to create.
 */
function detectUserCreateIntent(userMessage) {
  if (!userMessage) return null;
  const lower = userMessage.toLowerCase();

  // ── User wants to CREATE a reminder ──
  // Must have active creation verb + reminder context, not just asking about reminders
  if (/(?:set|buat|create|add|tambah)\s*(?:kan|lah)?\s*(?:reminder|peringatan|alarm|aku|saya|i|me)?\b/i.test(lower) ||
    /\b(?:ingatkan|remind)\s+(?:aku|saya|me|i)\b/i.test(lower) ||
    /\bset\s*(?:kan|lah)?\s+(?:reminder|peringatan)?\b/i.test(lower)) {
    // Ensure it's NOT asking about existing reminders (list/show/check patterns)
    if (!/\b(?:apa|list|show|senarai|tunjuk|check|semak|lihat|tengok)\s+(?:reminder|peringatan|schedule|jadual)\b/i.test(lower)) {
      return 'create_reminder';
    }
  }

  // ── User wants to CREATE an event ──
  if (/(?:set|buat|create|add|tambah|masuk)\s*(?:kan|lah)?\s*(?:event|jadual|schedule|kalendar|calendar|meeting|temujanji)/i.test(lower) ||
    /\b(?:jadualkan|schedule)\b/i.test(lower)) {
    return 'create_event';
  }

  // ── User wants to CREATE a note ──
  if (/(?:simpan|save|tulis|catat|note|nota|rekod)\s*(?:kan|lah)?\s*(?:nota|note|fact|fakta)?/i.test(lower) ||
    /\b(?:notakan|catatkan|simpankan)\b/i.test(lower)) {
    return 'add_note';
  }

  // ── User wants to SEARCH ──
  if (/(?:cari|search|google|check|semak|tengok)\s*(?:kan|lah)?\s*(?:dalam|online|internet|web|untuk|tentang|about)?/i.test(lower) ||
    /\b(?:searchkan|carikan|checkkan)\b/i.test(lower)) {
    return 'web_search';
  }

  return null;
}

/**
 * ── COMPREHENSIVE Human Fact Hallucination Detector ─────────────────────────
 *
 * Detects when the LLM fabricates claims about the user's LIFE that are NOT
 * backed by the provided user facts or the user's current message.
 *
 * Covers 12 categories (D–O): location, schedule, preferences, health,
 * emotions, relationships, finances, knowledge, future predictions,
 * intent guessing, numerical precision, and identity/self claims.
 *
 * The core principle: if the LLM asserts something specific about the user
 * that isn't in userFacts AND the user didn't just say it, it's a hallucination.
 *
 * @param {string} content - the LLM's message content
 * @param {Array<{key:string, value:string}>} userFacts - facts provided to LLM
 * @param {string} userMessage - the user's original message (to check if user just revealed this)
 * @returns {{isHallucination: boolean, categories: Array<string>, claims: Array<string>, confidence: number}}
 */
function detectHumanFactHallucination(content, userFacts = [], userMessage = '') {
  if (!content || typeof content !== 'string') {
    return { isHallucination: false, categories: [], claims: [], confidence: 0 };
  }

  const contentLower = content.toLowerCase();
  const userLower = (userMessage || '').toLowerCase();
  const categories = [];
  const claims = [];
  let totalConfidence = 0;

  // ── Helper: check if a claim is backed by ANY user fact ───────────────
  const isBackedByFacts = (keywords) => {
    if (!userFacts || userFacts.length === 0) return false;
    return userFacts.some(fact => {
      const factText = (fact.key + ' ' + fact.value).toLowerCase();
      return keywords.some(kw => factText.includes(kw));
    });
  };

  // ── Helper: check if user just mentioned this in their message ────────
  const userJustSaid = (keywords) => {
    return keywords.some(kw => userLower.includes(kw));
  };

  // ── Helper: extract the sentence containing the claim ─────────────────
  const extractSentence = (text, phrase) => {
    const idx = text.indexOf(phrase);
    if (idx === -1) return text.slice(0, 80).trim();
    const sentenceStart = Math.max(0, text.lastIndexOf('.', idx - 1), text.lastIndexOf('!', idx - 1), text.lastIndexOf('?', idx - 1), text.lastIndexOf('\n', idx - 1));
    const sentenceEnd = Math.min(text.length, ...[
      text.indexOf('.', idx + phrase.length),
      text.indexOf('!', idx + phrase.length),
      text.indexOf('?', idx + phrase.length),
      text.indexOf('\n', idx + phrase.length),
    ].filter(x => x !== -1));
    return text.slice(sentenceStart, sentenceEnd === text.length ? undefined : sentenceEnd).trim().replace(/^[.!?\s]+/, '');
  };

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY D: Location & Place (4 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const locationPatterns = [
    // D1: Claims where user IS right now
    { pattern: /\b(you('re| are)\s+(at|in|near|around|staying\s+at|currently\s+(at|in))|awak\s+(sedang\s+)?(di|dekat|berdekatan|berada\s+di|ada\s+di)|kau\s+(sedang\s+)?(di|dekat|ada\s+di))\b/i, sub: 'D1:current-location' },
    // D2: Specific distance claims
    { pattern: /\b(it'?s?\s+\d+\s*(km|kilometer|miles?|minit|minutes?)\s+(from|away|to)\s+(your|the)|jarak\s+\d+\s*(km|minit)|dalam\s+\d+\s*(km|minit)\s+dari\s+(rumah|tempat|office))\b/i, sub: 'D2:specific-distance' },
    // D3: Claims about home/office location
    { pattern: /\b(your\s+(home|house|office|workplace|apartment|condo|place)\s+(is|are)\s+(at|in|near|located|situated)|rumah\s+(awak|kau|anda)\s+(di|dekat|dekat\s+dengan|berada\s+di)|pejabat\s+(awak|kau)\s+(di|dekat)|awak\s+(duduk|tinggal)\s+(di|dekat))\b/i, sub: 'D3:home-office-location' },
    // D4: "Near your place" type claims
    { pattern: /\b(near|dekat|close\s+to|walking\s+distance\s+from|berdekatan\s+dengan|sebelah)\s+(your|rumah|tempat|office|awak|kau)\b/i, sub: 'D4:nearby-claim' },
  ];
  for (const { pattern, sub } of locationPatterns) {
    if (pattern.test(contentLower)) {
      // Check: does user have location facts?
      const locationKeywords = ['location', 'city', 'address', 'home', 'office', 'tempat', 'rumah', 'alamat', 'lokasi', 'duduk', 'tinggal', 'live'];
      if (!isBackedByFacts(locationKeywords) && !userJustSaid(['saya di', 'saya dekat', 'aku di', 'aku dekat', 'i am at', "i'm at", 'i am in', "i'm in", 'saya duduk', 'saya tinggal', 'i live in', 'i live at'])) {
        categories.push('location');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.8;
        break; // One hit per category is enough
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY E: Personal Schedule (5 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const schedulePatterns = [
    // E1: Fabricated meetings
    { pattern: /\b(you\s+have\s+(a|an)\s+(meeting|appointment|event|call|session)|awak\s+ada\s+(meeting|temujanji|event|appointment)|kau\s+ada\s+(meeting|temujanji))\b/i, sub: 'E1:fabricated-meeting' },
    // E2: Claims user is free
    { pattern: /\b(you('re| are)\s+free\s+(at|on|tomorrow|today|later|this)|awak\s+(free|lapang|tak\s+de\s+apa)\s+(pada|esok|hari\s+ni|nanti)|you\s+don'?t\s+have\s+anything\s+(at|on|scheduled))\b/i, sub: 'E2:assumes-free' },
    // E3: Labels user's day
    { pattern: /\b(today\s+is\s+(your|a)\s+(busy|light|packed|free|hectic|easy|long|slow|full)\s+day|hari\s+ni\s+(awak|hari)\s+(sibuk|lapang|ringan|penuh|panjang)|this\s+is\s+(your|a)\s+(busy|hectic)\s+(day|week|morning))\b/i, sub: 'E3:labels-day' },
    // E4: Fabricated schedule patterns
    { pattern: /\b(you\s+(always|usually|normally|typically)\s+have\s+(meetings?|calls?|classes?|appointments?)\s+(on|every|at)|awak\s+(selalu|biasa|selalunya)\s+ada\s+(meeting|kelas|temujanji)\s+(pada|setiap))\b/i, sub: 'E4:schedule-pattern' },
    // E5: Fabricated upcoming activity
    { pattern: /\b(your\s+next\s+(event|meeting|appointment|class|activity|thing)\s+is|aktiviti\s+(awak|kau)\s+seterusnya|lepas\s+ni\s+(awak|kau)\s+ada)\b/i, sub: 'E5:next-activity' },
  ];
  for (const { pattern, sub } of schedulePatterns) {
    if (pattern.test(contentLower)) {
      // Check: does user have calendar/schedule facts?
      const scheduleKeywords = ['meeting', 'event', 'appointment', 'class', 'jadual', 'schedule', 'calendar', 'kelas', 'temujanji'];
      // Also check: did user just tell the bot about their schedule?
      const userJustToldSchedule = /\b(i\s+have\s+(a|an)\s+(meeting|event|appointment)|saya\s+ada\s+(meeting|temujanji|event)|aku\s+ada\s+(meeting|temujanji)|(my|saya|aku)\s+(schedule|jadual))\b/i;
      if (!isBackedByFacts(scheduleKeywords) && !userJustSaid(['remind', 'ingatkan', 'set', 'buat', 'create', 'add', 'tambah']) && !userJustToldSchedule.test(userLower)) {
        categories.push('schedule');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.75;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY F: Preferences & Tastes (5 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const preferencePatterns = [
    // F1: "You'd love/like/enjoy X"
    { pattern: /\b(you('d| would)\s+(love|like|enjoy|appreciate|hate|dislike)|awak\s+(mesti|pasti|akan|tentu)\s+(suka|minat|benci|gemar|teruja)|kau\s+(mesti|pasti)\s+(suka|minat|benci))\b/i, sub: 'F1:assumes-taste' },
    // F2: "Since you prefer X..."
    { pattern: /\b(since\s+you\s+prefer|because\s+you\s+(like|love|prefer|enjoy|hate)|sebab\s+(awak|kau)\s+(suka|prefer|minat|gemar|benci)|memandangkan\s+(awak|kau)\s+(suka|minat))\b/i, sub: 'F2:assumes-preference' },
    // F3: "Your favorite X is..."
    { pattern: /\b(your\s+favo(u?)rite\s+\w+\s+is|favo(u?)rite\s+(awak|kau)\s+(ialah|adalah)|(awak|kau)\s+punya\s+favo(u?)rite|kegemaran\s+(awak|kau)\s+(ialah|adalah))\b/i, sub: 'F3:favorite-claim' },
    // F4: "Since you love X" — hobby/interest assumption
    { pattern: /\b(since\s+you\s+(love|enjoy|are\s+into|are\s+a\s+fan\s+of)|knowing\s+you\s+(like|love)|sebab\s+(awak|kau)\s+(suka|minat|gemar|hobi))\b/i, sub: 'F4:hobby-assumption' },
    // F5: "You always choose/pick X"
    { pattern: /\b(you\s+(always|usually|tend\s+to|typically)\s+(choose|pick|go\s+for|prefer|select|opt\s+for)|awak\s+(selalu|biasa|selalunya)\s+(pilih|ambil|prefer))\b/i, sub: 'F5:choice-pattern' },
  ];
  for (const { pattern, sub } of preferencePatterns) {
    if (pattern.test(contentLower)) {
      const prefKeywords = ['prefer', 'like', 'love', 'favorite', 'hate', 'suka', 'minat', 'gemar', 'favourite', 'kegemaran', 'hobi', 'hobby'];
      const userJustToldPref = /\b(i\s+(like|love|prefer|hate|enjoy)|saya\s+(suka|minat|gemar|benci|prefer)|aku\s+(suka|minat|gemar)|my\s+favou?rite|kegemaran\s+(saya|aku))\b/i;
      if (!isBackedByFacts(prefKeywords) && !userJustToldPref.test(userLower)) {
        categories.push('preferences');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.7;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY G: Health & Body (5 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const healthPatterns = [
    // G1: Sleep quality claims
    { pattern: /\b(you\s+(haven'?t|didn'?t|don'?t|seem\s+to\s+have)\s+(slept|sleep|rest(ed)?)\s+(well|enough|properly|much)|awak\s+(tak|tidak|nampak\s+macam)\s+(tidur|lena|rehat)\s+(cukup|lena|baik))\b/i, sub: 'G1:sleep-quality' },
    // G2: Fitness/exercise assumptions
    { pattern: /\b(you\s+(should|need\s+to|ought\s+to|must)\s+(exercise|work\s+out|move|stretch)\s+more|awak\s+(patut|perlu|kena|mesti)\s+(bersenam|exercise|workout|gerak))\b/i, sub: 'G2:fitness-advice' },
    // G3: Medical/health diagnosis
    { pattern: /\b(your\s+(headache|pain|fatigue|stress|anxiety|insomnia)\s+(is|comes\s+from|might\s+be|could\s+be|probably)|(sakit|pening|letih|stress|susah\s+tidur)\s+(awak|kau)\s+(ialah|adalah|disebabkan|mungkin|sebab))\b/i, sub: 'G3:medical-diagnosis' },
    // G4: Physical condition assumption
    { pattern: /\b(based\s+on\s+your\s+(back|neck|knee|shoulder|condition|health)|berdasarkan\s+(sakit|keadaan|kondisi)\s+(awak|kau)|you\s+have\s+(been\s+having|suffering\s+from|dealing\s+with))\b/i, sub: 'G4:physical-condition' },
    // G5: Diet/calorie claims
    { pattern: /\b(you\s+(need|require|should\s+get)\s+(about|around|approximately)?\s*\d+\s*(calories|kcal|cal)|awak\s+(perlu|patut)\s+(dapat|ambil)\s+\d+\s*(kalori|kcal)|your\s+(diet|nutrition|intake))\b/i, sub: 'G5:diet-claims' },
  ];
  for (const { pattern, sub } of healthPatterns) {
    if (pattern.test(contentLower)) {
      const healthKeywords = ['health', 'sleep', 'exercise', 'diet', 'pain', 'sakit', 'tidur', 'senaman', 'gym', 'workout', 'kalori'];
      const userJustToldHealth = /\b(i\s+(haven'?t|didn'?t|can'?t)\s+sleep|saya\s+(tak|tidak)\s+(boleh|dapat)\s+tidur|(my|saya|aku)\s+(back|neck|head|knee|belakang|kepala|pinggang|lutut)\s+(hurt|pain|sakit)|i\s+(have|got)\s+(a|an)\s+(headache|migraine|pain)|saya\s+(sakit|pening|letih))\b/i;
      if (!isBackedByFacts(healthKeywords) && !userJustToldHealth.test(userLower)) {
        categories.push('health');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.85; // Higher — health claims are dangerous
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY H: Emotions & Mental State (5 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const emotionPatterns = [
    // H1: "You seem X today" — allow optional adverb between seem/look and emotion
    { pattern: /\b(you\s+(seem|look|sound|appear)\s+(?:\w+\s+)?(stressed|anxious|tired|excited|happy|sad|upset|worried|nervous|angry|frustrated|depressed|down|energetic|motivated|lazy|bored)\s*(today|right\s*now|at\s*the\s*moment)?|awak\s+(nampak|macam|tengok)\s+(?:\w+\s+)?(stress|penat|letih|sedih|marah|gembira|risau|teruja))\b/i, sub: 'H1:emotion-assumption' },
    // H2: "I can tell you're X"
    { pattern: /\b(i\s+can\s+(tell|sense|feel|see)\s+you('re| are)\s+(stressed|anxious|tired|excited|happy|sad|upset|worried|nervous|angry|frustrated|motivated)|saya\s+(boleh|dapat)\s+(rasa|lihat|agak)\s+(awak|kau)\s+(stress|penat|sedih|marah|gembira|risau|teruja))\b/i, sub: 'H2:mind-reading' },
    // H3: "You're worried about X"
    { pattern: /\b(you('re| are)\s+(worried|anxious|stressed|nervous|concerned|upset|excited|happy)\s+about|awak\s+(risau|stress|bimbang|teruja|gembira)\s+(tentang|pasal|dengan))\b/i, sub: 'H3:worry-about' },
    // H4: "You sound X" from text
    { pattern: /\b(you\s+sound\s+(stressed|tired|excited|happy|sad|upset|frustrated|angry|annoyed)|awak\s+(bunyi|sound)\s+(macam|seperti)\s+(stress|penat|sedih|marah|gembira|teruja))\b/i, sub: 'H4:sound-assumption' },
    // H5: "Deep down you feel..."
    { pattern: /\b(deep\s+down\s+you('re| are| feel)|sebenarnya\s+(awak|kau)\s+(rasa|sedang)|honestly\s+you\s+(seem|look|feel)|terus\s+terang\s+(awak|kau)\s+(nampak|rasa))\b/i, sub: 'H5:deep-feeling' },
  ];
  for (const { pattern, sub } of emotionPatterns) {
    if (pattern.test(contentLower)) {
      const emotionKeywords = ['mood', 'feeling', 'emotion', 'stress', 'happy', 'sad', 'anxious', 'perasaan', 'emosi', 'mood', 'rasa'];
      const userJustToldEmotion = /\b(i('?m| am)\s+(stressed|anxious|tired|excited|happy|sad|upset|worried|nervous|angry|frustrated|depressed|down|energetic|motivated|lazy|bored|feeling)|saya\s+(stress|penat|letih|sedih|marah|gembira|risau|teruja|rasa)|aku\s+(stress|penat|letih|sedih|marah|gembira|risau))\b/i;
      if (!isBackedByFacts(emotionKeywords) && !userJustToldEmotion.test(userLower)) {
        categories.push('emotions');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.9; // Highest — emotional mind-reading is very wrong
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY I: Relationships & Social (6 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const relationshipPatterns = [
    // I1: Spouse/partner preference claims
    { pattern: /\b(your\s+(wife|husband|girlfriend|boyfriend|partner|spouse|isteri|suami)(?:\s+\w+)?\s+(would|might|will|pasti|mesti|tentu)\s+(like|love|enjoy|appreciate|suka|minat))\b/i, sub: 'I1:spouse-preference' },
    // I2: Fabricated social interactions
    { pattern: /\b(your\s+(friend|buddy|mate)\s+\w+\s+(told|said|mentioned|shared|texted|called|bagitahu|cakap|beritahu)|kawan\s+(awak|kau)\s+\w+\s+(cakap|bagitahu|beritahu))\b/i, sub: 'I2:friend-interaction' },
    // I3: Work relationship claims
    { pattern: /\b(you\s+and\s+your\s+(colleague|coworker|boss|manager|teammate|team)\s+(often|always|usually|sometimes)|awak\s+dengan\s+(kolega|bos|rakan\s+sekerja|team)\s+(selalu|biasa|sering))\b/i, sub: 'I3:work-relationship' },
    // I4: Fabricated family member names/actions
    { pattern: /\b(your\s+(brother|sister|mom|dad|mother|father|son|daughter|uncle|aunt|cousin)\s+\w+\s+(is|does|said|told|always|usually)|(abang|adik|kakak|mak|ayah|ibu|bapa|pakcik|makcik)\s+(awak|kau)\s+\w+)\b/i, sub: 'I4:family-member' },
    // I5: Social activity assumptions
    { pattern: /\b(you('re| are)\s+(going|hanging|meeting)\s+(out\s+with|with)\s+(friends?|family|people|someone|kawan|keluarga)|awak\s+(keluar|pergi|jumpa)\s+(dengan\s+)?(kawan|family|keluarga))\b/i, sub: 'I5:social-activity' },
    // I6: Parent/family claims
    { pattern: /\b(your\s+(mom|dad|mother|father|parent)\s+(always|usually|often)\s+(says?|tells?|does)|(mak|ayah|ibu|bapa)\s+(awak|kau)\s+(selalu|biasa)\s+(cakap|buat))\b/i, sub: 'I6:parent-claim' },
  ];
  for (const { pattern, sub } of relationshipPatterns) {
    if (pattern.test(contentLower)) {
      const relKeywords = ['wife', 'husband', 'spouse', 'friend', 'family', 'brother', 'sister', 'mom', 'dad', 'isteri', 'suami', 'kawan', 'keluarga', 'abang', 'adik', 'kakak', 'mak', 'ayah', 'colleague', 'boss', 'kolega', 'bos'];
      const userJustToldRel = /\b(my\s+(wife|husband|girlfriend|boyfriend|partner|spouse|friend|brother|sister|mom|dad|mother|father|son|daughter)|(isteri|suami|kawan|abang|adik|kakak|mak|ayah|anak)\s+(saya|aku)|i\s+(told|said|spoke|talked|met|saw))\b/i;
      if (!isBackedByFacts(relKeywords) && !userJustToldRel.test(userLower)) {
        categories.push('relationships');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.8;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY J: Financial (6 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const financialPatterns = [
    // J1: Affordability claims
    { pattern: /\b(you\s+(can|could|should\s+be\s+able\s+to)\s+afford|awak\s+(mampu|boleh|terdaya)\s+(beli|bayar)|within\s+your\s+budget|mengikut\s+bajet\s+(awak|kau)|it'?s?\s+within\s+your\s+(price\s+)?range)\b/i, sub: 'J1:affordability' },
    // J2: Budget claims
    { pattern: /\b(your\s+budget\s+(is|seems\s+to\s+be|looks\s+like|appears\s+to\s+be)\s+(?:about|around|approximately\s+)?(?:rm|myr|\$|usd)?\s*\d+|bajet\s+(awak|kau)\s+(adalah|ialah|sekitar|dalam\s+lingkungan)\s*(rm)?\s*\d+)\b/i, sub: 'J2:budget-claim' },
    // J3: Past spending claims
    { pattern: /\b(you\s+(spent|paid|bought|purchased|forked\s+out|dropped)\s+(?:about|around|approximately\s+)?(?:rm|myr|\$|usd)?\s*\d+|awak\s+(belanja|bayar|beli)\s+(?:dalam\s+)?(?:rm)?\s*\d+|last\s+week\s+you\s+(spent|paid))\b/i, sub: 'J3:past-spending' },
    // J4: Savings/investment claims
    { pattern: /\b(based\s+on\s+your\s+(savings?|investment|portfolio|financial|income)|berdasarkan\s+(simpanan|pelaburan|kewangan|pendapatan)\s+(awak|kau)|with\s+your\s+(savings?|income|salary))\b/i, sub: 'J4:savings-claim' },
    // J5: Salary/income claims
    { pattern: /\b(your\s+(salary|income|pay|earnings?)\s+(is|seems|looks|appears|must\s+be|should\s+be)|(gaji|pendapatan)\s+(awak|kau)\s+(adalah|ialah|sekitar|dalam)|with\s+your\s+(salary|income|pay\s*check))\b/i, sub: 'J5:salary-claim' },
    // J6: Specific financial advice
    { pattern: /\b(you\s+should\s+(invest|put\s+money|buy)\s+(in|into)|awak\s+(patut|perlu|kena)\s+(labur|beli|invest)\s+(dalam|emas|saham|crypto|bitcoin|property|rumah)|this\s+(stock|crypto|coin|investment)\s+(is|will|going\s+to))\b/i, sub: 'J6:financial-advice' },
  ];
  for (const { pattern, sub } of financialPatterns) {
    if (pattern.test(contentLower)) {
      const finKeywords = ['budget', 'salary', 'income', 'money', 'finance', 'savings', 'investment', 'bajet', 'gaji', 'pendapatan', 'duit', 'wang', 'simpanan', 'labur', 'pelaburan'];
      const userJustToldFin = /\b(my\s+(budget|salary|income|savings?)|(bajet|gaji|pendapatan|simpanan|duit)\s+(saya|aku)|i\s+(spent|paid|bought|earn|make|have)\s+(?:about|around|approximately\s+)?(?:rm|myr|\$)?\s*\d+|saya\s+(belanja|bayar|beli|ada)\s+(?:rm)?\s*\d+)\b/i;
      if (!isBackedByFacts(finKeywords) && !userJustToldFin.test(userLower)) {
        categories.push('financial');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.85;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY K: Knowledge & Expertise (5 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const knowledgePatterns = [
    // K1: Profession claims
    { pattern: /\b(since\s+you('re| are)\s+(a|an)\s+(?:\w+\s+)?(developer|programmer|engineer|designer|doctor|lawyer|teacher|student|writer|artist|manager|consultant|freelancer|data\s*scientist)|sebab\s+(awak|kau)\s+(seorang\s+)?(?:\w+\s+)?(programmer|developer|engineer|doktor|guru|pensyarah|pelajar|designer|manager))\b/i, sub: 'K1:profession' },
    // K2: Skill claims
    { pattern: /\b(you\s+(know\s+how\s+to|can)\s+(code|program|design|write|build|create|develop)\s+(in|with|using)?\s*(python|javascript|react|figma|photoshop|excel|sql|java|c\+\+|ruby|php)?|awak\s+(tahu|boleh|pandai)\s+(coding|program|design|tulis|buat))\b/i, sub: 'K2:skill-claim' },
    // K3: Experience claims
    { pattern: /\b(given\s+your\s+(experience|background|expertise)\s+(with|in|as)|berdasarkan\s+(pengalaman|expertise|kemahiran)\s+(awak|kau)\s+(dalam|sebagai)|you('ve| have)\s+(worked|dealt|handled)\s+(with|in))\b/i, sub: 'K3:experience' },
    // K4: Education claims
    { pattern: /\b(since\s+you\s+(studied|majored|graduated|went\s+to|took)|sebab\s+(awak|kau)\s+(belajar|graduate|ambil)\s+(dalam|jurusan|bidang)|as\s+a\s+(graduate|alumni|student)\s+(of|from))\b/i, sub: 'K4:education' },
    // K5: "As you already know..."
    { pattern: /\b(as\s+you\s+(already\s+)?know|like\s+you\s+(already\s+)?know|seperti\s+(yang\s+)?(awak|kau)\s+(sedia\s+)?(tahu|maklum|sedia\s+maklum)|i('m| am)\s+sure\s+you('re| are)\s+(aware|familiar))\b/i, sub: 'K5:assumes-knowledge' },
  ];
  for (const { pattern, sub } of knowledgePatterns) {
    if (pattern.test(contentLower)) {
      const knowKeywords = ['profession', 'job', 'role', 'developer', 'engineer', 'designer', 'skill', 'education', 'kerjaya', 'pekerjaan', 'programmer', 'student', 'graduate', 'experience', 'pengalaman', 'kemahiran', 'pelajar'];
      const userJustToldKnow = /\b(i('?m| am)\s+(a|an)\s+(developer|programmer|engineer|designer|doctor|lawyer|teacher|student)|saya\s+(seorang\s+)?(programmer|developer|engineer|doktor|guru|pelajar|designer)|(i|saya|aku)\s+(know|tahu|pandai|boleh)\s+(code|program|coding|python|javascript|react))\b/i;
      if (!isBackedByFacts(knowKeywords) && !userJustToldKnow.test(userLower)) {
        categories.push('knowledge');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.75;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY L: Future Predictions (5 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const predictionPatterns = [
    // L1: Productivity predictions
    // L1: Productivity predictions — match on the key verb, allow intervening words
    { pattern: /\b(you('ll| will)\s+(finish|complete|get\s+done|wrap\s+up|be\s+done)\b|awak\s+(akan|mesti|pasti)\s+(siap|habis|selesai)\b|you\s+should\s+(finish|complete)\b)/i, sub: 'L1:productivity-prediction' },
    // L2: Project duration estimates
    { pattern: /\b(this\s+(project|task|work|thing|assignment)\s+(will|should|might|going\s+to)\s+take\s+(you\s+)?(about|around|approximately)\s+\d+\s+(days?|weeks?|months?|hours?)|projek\s+ni\s+(akan|mungkin)\s+ambil\s+(dalam\s+)?\d+\s+(hari|minggu|bulan|jam))\b/i, sub: 'L2:duration-estimate' },
    // L3: Progress predictions
    { pattern: /\b(you('re| are)\s+on\s+(track|pace|schedule|course)\s+(to|for)|awak\s+berada\s+di\s+(landasan|track)\s+(untuk)|you('ll| will)\s+(achieve|reach|hit)\s+(your\s+)?(goal|target))\b/i, sub: 'L3:progress-prediction' },
    // L4: Outcome predictions
    { pattern: /\b(you('ll| will)\s+(probably|likely|definitely|certainly|surely)\s+(get|win|pass|succeed|achieve|receive|land)|awak\s+(mesti|pasti|mungkin|akan)\s+(dapat|lulus|menang|berjaya))\b/i, sub: 'L4:outcome-prediction' },
    // L5: "By X you'll Y" future milestones
    { pattern: /\b(by\s+(next\s+)?(week|month|year|december|january|february|march|april|may|june|july|august|september|october|november)\s+(you('ll| will)|awak\s+akan)|dalam\s+\d+\s+(minggu|bulan|tahun)\s+(awak|kau)\s+(akan|pasti|mesti))\b/i, sub: 'L5:future-milestone' },
  ];
  for (const { pattern, sub } of predictionPatterns) {
    if (pattern.test(contentLower)) {
      const predKeywords = ['goal', 'target', 'deadline', 'progress', 'project', 'matlamat', 'projek', 'siap', 'finish', 'complete'];
      const userJustToldPred = /\b(i('ll| will)\s+(finish|complete|be\s+done)|saya\s+akan\s+(siap|habis)|(my|saya|aku)\s+(goal|target|matlamat|deadline)\s+(is|adalah))\b/i;
      if (!isBackedByFacts(predKeywords) && !userJustToldPred.test(userLower)) {
        categories.push('predictions');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.7;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY M: Intent/Motivation Guessing (4 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const intentPatterns = [
    // M1: "You want this because..."
    { pattern: /\b(you\s+(want|need|are\s+looking)\s+(this|it|that)\s+because|awak\s+(nak|mahu|perlu)\s+(ni|ini|itu)\s+sebab|you('re| are)\s+(asking|looking|searching)\s+(because|since|for))\b/i, sub: 'M1:motivation-guess' },
    // M2: "You're asking because..."
    { pattern: /\b(you('re| are)\s+(asking|wondering|questioning)\s+(this|that|about|because|since)|awak\s+(tanya|bertanya)\s+(ni|ini|sebab|kerana))\b/i, sub: 'M2:question-motive' },
    // M3: "What you really mean is..."
    { pattern: /\b(what\s+you\s+(really|actually|truly)\s+(mean|want|need|are\s+saying)\s+is|apa\s+yang\s+(awak|kau)\s+(sebenarnya|memang|betul-betul)\s+(maksudkan|nak|mahu)\s+(ialah|adalah)|i\s+think\s+what\s+you('re| are)\s+(really|actually)\s+(saying|asking|looking\s+for))\b/i, sub: 'M3:meaning-guess' },
    // M4: Psychoanalysis
    { pattern: /\b(this\s+(stems|comes|originates)\s+from\s+your|ini\s+(berpunca|datang)\s+dari\s+(awak|kau)\s+(punya|nya)?|subconsciously\s+you('re| are)|deep\s+down\s+you\s+(want|need|fear|desire)|sebenarnya\s+(awak|kau)\s+(nak|mahu|takut|perlu))\b/i, sub: 'M4:psychoanalysis' },
  ];
  for (const { pattern, sub } of intentPatterns) {
    if (pattern.test(contentLower)) {
      // Intent guessing is almost always hallucination unless user explicitly stated their motivation
      const userStatedMotive = /\b(i('?m| am)\s+(asking|looking|searching|trying)\s+(because|since|to|for)|saya\s+(tanya|cari|nak)\s+(sebab|kerana|untuk)|(my|saya|aku)\s+(reason|motivation|sebab|alasan)\s+(is|adalah))\b/i;
      if (!userStatedMotive.test(userLower)) {
        categories.push('intent-guessing');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.8;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY N: Numbers & Precision Without Basis (4 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const numbersPatterns = [
    // N1: Specific duration estimates
    { pattern: /\b(that('ll| will| should| might| would)\s+take\s+(you\s+)?(about|around|approximately)\s+\d+\s+(minutes?|hours?|seconds?)|ia\s+(akan|mungkin)\s+ambil\s+(dalam\s+)?\d+\s+(minit|jam|saat)|you\s+need\s+(about|around|approximately)\s+\d+\s+(minutes?|hours?))\b/i, sub: 'N1:specific-duration' },
    // N2: Fabricated statistics
    { pattern: /\b(\d{1,3}\s*%\s+of\s+(people|users|developers|malaysians?|humans?|customers?)\s+(prefer|use|like|choose|are)|(about|around|approximately|roughly)\s+\d{1,3}\s*%\s+of)\b/i, sub: 'N2:fake-statistic' },
    // N3: Precise quantity claims
    { pattern: /\b(you\s+(have|own|possess)\s+(about|around|approximately)\s+\d+\s+(unread\s+)?(emails?|messages?|notifications?|files?|documents?|tasks?)|awak\s+ada\s+\d+\s+(email|mesej|notifikasi|fail|dokumen|tugas|task)\s+(belum\s+(baca|selesai)|tertunggak))\b/i, sub: 'N3:precise-quantity' },
    // N4: Subjective ranking as fact
    { pattern: /\b(this\s+is\s+the\s+(#1|number\s+one|best|top|greatest|perfect|ideal|optimal|ultimate|worst|#\d+)\s+(option|choice|solution|way|approach|pick)\s+for\s+you|ini\s+(ialah|adalah)\s+(pilihan|jalan|cara|solusi)\s+(terbaik|paling\s+bagus|#1|nombor\s+satu)\s+untuk\s+(awak|kau))\b/i, sub: 'N4:subjective-ranking' },
  ];
  for (const { pattern, sub } of numbersPatterns) {
    if (pattern.test(contentLower)) {
      const numKeywords = ['duration', 'time', 'estimate', 'count', 'number', 'amount', 'statistic', 'tempoh', 'anggaran', 'bilangan', 'jumlah'];
      const userJustToldNum = /\b(i\s+have\s+\d+\s+(emails?|messages?|notifications?|tasks?|files?)|saya\s+ada\s+\d+\s+(email|mesej|notifikasi|tugas|fail)|it\s+(took|takes?)\s+(me\s+)?\d+\s+(minutes?|hours?)|ambil\s+(masa\s+)?\d+\s+(minit|jam))\b/i;
      if (!isBackedByFacts(numKeywords) && !userJustToldNum.test(userLower)) {
        categories.push('numbers');
        claims.push(extractSentence(contentLower, sub.split(':')[1]));
        totalConfidence += 0.65;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CATEGORY O: Identity & Self Claims (3 scenarios)
  // ═══════════════════════════════════════════════════════════════════════
  const identityPatterns = [
    // O1: Fabricated bot capability
    { pattern: /\b(i\s+can\s+(?:help\s+you\s+)?(analyze|read|process|scan|review|examine|inspect|extract|parse|convert|translate|generate|create|build|make|design|draw|edit|modify)\s+(your\s+)?(pdf|doc|document|file|image|photo|video|audio|spreadsheet|excel|powerpoint|presentation)|saya\s+boleh\s+(?:tolong\s+)?(analisa|baca|proses|imbas|review|periksa|ekstrak|parse|tukar|translate|jana|bina|buat|design|edit|ubah)\s+(pdf|dokumen|fail|gambar|foto|video|audio|excel))\b/i, sub: 'O1:fake-capability' },
    // O2: "I remember you mentioned..." (not in history)
    { pattern: /\b(i\s+remember\s+you\s+(mentioning|saying|telling|talking|sharing|discussing)|saya\s+ingat\s+(awak|kau)\s+(pernah|ada)\s+(cakap|sebut|bagitahu|cerita|bincang)|as\s+you\s+(mentioned|said|told)\s+(before|earlier|previously|last\s+time)|seperti\s+(yang\s+)?(awak|kau)\s+(cakap|sebut)\s+(sebelum|dulu|awal\s+tadi))\b/i, sub: 'O2:fake-memory' },
    // O3: "I've been tracking/analyzing your..."
    { pattern: /\b(i('ve| have)\s+been\s+(tracking|monitoring|analyzing|watching|observing|noticing|following)\s+your|saya\s+(dah|telah|sedang)\s+(track|monitor|analisa|perhati|ikut)\s+(awak|kau)\s+(punya|nya)?|based\s+on\s+(my|our)\s+(analysis|tracking|monitoring|observation))\b/i, sub: 'O3:fake-tracking' },
  ];
  for (const { pattern, sub } of identityPatterns) {
    if (pattern.test(contentLower)) {
      // Identity claims are almost always hallucination — flag immediately
      categories.push('identity');
      claims.push(extractSentence(contentLower, sub.split(':')[1]));
      totalConfidence += 0.9;
      break;
    }
  }

  // ── Final assessment ──────────────────────────────────────────────────
  // Require at least ONE category hit with confidence >= 0.65
  const isHallucination = categories.length >= 1 && totalConfidence >= 0.65;

  if (isHallucination) {
    console.log('[Validator] 👤 Human fact hallucination detected! categories=' + categories.join(', ') + ' | confidence=' + totalConfidence.toFixed(2));
    for (const c of claims) {
      console.log('[Validator]    Claim: ' + c.slice(0, 120));
    }
  }

  return { isHallucination, categories, claims, confidence: Math.min(totalConfidence, 1.0) };
}

/**
 * Detect if LLM is fabricating real-time/world facts that should have been a web search.
 * Catches cases where the bot confidently answers weather, news, stock prices, etc.
 * without actually calling web_search — these answers are almost certainly hallucinations.
 *
 * @param {string} content - the LLM's message content
 * @param {string} userMessage - the user's original message (to check intent)
 * @returns {{isHallucination: boolean, reasons: Array<string>, suggestedQuery: string|null}}
 */
function detectWebSearchHallucination(content, userMessage) {
  if (!content || !userMessage || typeof content !== 'string' || typeof userMessage !== 'string') {
    return { isHallucination: false, reasons: [], suggestedQuery: null };
  }

  const contentLower = content.toLowerCase();
  const userLower = userMessage.toLowerCase().trim();
  const reasons = [];

  // ═══════════════════════════════════════════════════════════════
  // Step 1: Does the USER's message ask for real-time/current info?
  // ═══════════════════════════════════════════════════════════════
  const realTimePatterns = [
    // Weather
    { pattern: /\b(cuaca|weather|hujan|rain|panas|ribut|storm|banjir|mendung|cerah|suhu|temperature|berangin)\b/i, category: 'weather' },
    // Current news
    { pattern: /\b(berita|news|terkini|latest|headline|tular|viral|semasa|current|hari\s*(ni|ini)|today)\b/i, category: 'news' },
    // Stock/crypto/price
    { pattern: /\b(harga|price|stock|market|saham|nasdaq|dow|snp|bitcoin|btc|crypto|eth|ringgit|myr|usd|emas|minyak)\b/i, category: 'price' },
    // Sports scores (live)
    { pattern: /\b(bola|football|soccer|score|keputusan|perlawanan|match|liga|league|epl|ucl|serie\s*a)\b/i, category: 'sports' },
    // Politics / current affairs
    { pattern: /\b(presiden|president|pm\s*malaysia|perdana\s*menteri|pilihan\s*raya|election|parlimen|kabinet|menteri)\b/i, category: 'politics' },
    // Trending topics
    { pattern: /\b(trending|trend|popular|famous|terkenal|skandal|kontroversi|isu\s*semasa|sedang\s*(hangat|viral))\b/i, category: 'trending' },
    // Events happening today/now
    { pattern: /\b(sekarang|now|currently|sedang\s*(berlaku|terjadi)|hari\s*(ni|ini)|today|malam\s*(ni|ini)|tonight)\b/i, category: 'current_event' },
  ];

  let userCategory = null;
  for (const { pattern, category } of realTimePatterns) {
    if (pattern.test(userLower)) {
      userCategory = category;
      break;
    }
  }

  // If user is not asking for real-time info, skip
  if (!userCategory) {
    return { isHallucination: false, reasons: [], suggestedQuery: null };
  }

  // ═══════════════════════════════════════════════════════════════
  // Step 2: Does the LLM's response contain SPECIFIC claims?
  // Generic responses like "Saya tak pasti" are fine — we catch
  // confident assertions like "Cyberjaya cerah je harini"
  // ═══════════════════════════════════════════════════════════════

  // LLM is hedging — this is acceptable
  const hedgingPatterns = [
    /saya\s*tak\s*(pasti|tahu|dapat|boleh)/i,
    /\bi('?m| am)\s*not\s*(sure|certain|able)/i,
    /tak\s*(dapat|boleh)\s*(akses|check|semak|lihat)/i,
    /tidak\s*(pasti|tahu)/i,
    /let\s*me\s*(check|search|look|find)/i,
    /kejap.*?(?:check|search|cari)/i,
    /nak\s*(check|search|cari|tengok)\s*dulu/i,
    /i\s*(don't|do\s*not|cannot|can't)\s*(know|have|access)/i,
    /maaf.*?(?:tak|tidak|belum)\s*(?:tahu|pasti)/i,
    /saya\s*(perlu|nak|akan)\s*(check|cari|search)/i,
  ];

  let isHedging = false;
  for (const pattern of hedgingPatterns) {
    if (pattern.test(contentLower)) {
      isHedging = true;
      break;
    }
  }

  if (isHedging) {
    // LLM acknowledges it doesn't know — this is good behavior
    return { isHallucination: false, reasons: [], suggestedQuery: null };
  }

  // ═══════════════════════════════════════════════════════════════
  // Step 3: Check if LLM made specific factual claims
  // If the response contains specific info (numbers, locations, times,
  // names) about a real-time topic, it's likely hallucinated.
  // ═══════════════════════════════════════════════════════════════
  const specificClaimIndicators = [
    // Specific numbers/quantities in context of real-time info
    /\b(\d{1,2}[°º]\s*[CF]|\d{1,3}\s*%|\$\d+|\d+\s*ringgit|rm\s*\d+)\b/i,
    // Specific times for events
    /\b(akan|bakal|dijangka)\s+(berlaku|bermula|bermula|start|happen)\b/i,
    // Named entities + current status
    /\b(sedang|kini|sekarang|currently|now|today)\b.{1,30}\b(di|at|dalam|pada)\b/i,
    // Weather assertions
    /\b(cuaca|weather).{1,30}\b(cerah|mendung|hujan|panas|ribut|clear|cloudy|rain|sunny|storm)\b/i,
    // Price assertions
    /\b(harga|price).{1,30}\b(naik|turun|mahal|murah|increase|decrease|up|down|rm|usd)\b/i,
    // Score/result assertions
    /\b(menang|kalah|seri|win|lose|draw|score).{1,30}\b(\d+\s*[-–]\s*\d+|\d+\s*gol)\b/i,
  ];

  let hasSpecificClaim = false;
  for (const pattern of specificClaimIndicators) {
    if (pattern.test(contentLower)) {
      hasSpecificClaim = true;
      reasons.push('LLM made specific claim about ' + userCategory + ' without web_search');
      break;
    }
  }

  // Also check: if the response is long (>150 chars) and about real-time topic,
  // it's likely trying to provide detailed fake info
  if (!hasSpecificClaim && content.length > 150) {
    // Check if the content looks informative rather than conversational
    const informativeIndicators = [
      /sekarang\s+(di|pada|dalam)/i,
      /currently\s+(in|at|on)/i,
      /pada\s+(masa|waktu|ketika)\s+(ini|sekarang|sama)/i,
      /as\s+of\s+(now|today)/i,
      /suhu|temperature|kelembapan|humidity|kelajuan|wind/i,
      /ringgit|usd|dollar|rm\s*\d/i,
      /index|indeks|pasaran/i,
    ];
    for (const pattern of informativeIndicators) {
      if (pattern.test(contentLower)) {
        hasSpecificClaim = true;
        reasons.push('LLM provided detailed real-time info about ' + userCategory + ' without web_search');
        break;
      }
    }
  }

  if (!hasSpecificClaim) {
    return { isHallucination: false, reasons: [], suggestedQuery: null };
  }

  // Extract a good search query from the user's message
  let suggestedQuery = userMessage
    .replace(/^(?:tolong\s+)?(?:cari|search|check|find|look\s*up)\s+/i, '')
    .replace(/\b(?:aku|saya|i|you|tolong|please|boleh\s+(?:tak|kah)?|can\s+you|nak\s+(?:tau|tahu)?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (suggestedQuery.length < 5) {
    suggestedQuery = userMessage.trim();
  }

  console.log('[Validator] 🔍 Web search hallucination detected! category=' + userCategory + ' | query="' + suggestedQuery.slice(0, 80) + '"');
  console.log('[Validator]    User asked:', userMessage.slice(0, 150));
  console.log('[Validator]    LLM said:', content.slice(0, 150));

  return {
    isHallucination: true,
    reasons,
    suggestedQuery,
  };
}

function validateLLMResponse(llmResponse, context = {}) {
  const issues = [];
  let isValid = true;

  // Only validate message-type responses
  if (llmResponse.type === 'message' && llmResponse.content) {
    const content = llmResponse.content;

    // Check for action hallucinations
    const actionCheck = detectActionHallucination(content);
    if (actionCheck.isHallucination) {
      issues.push('Action hallucination detected (confidence: ' +
        (actionCheck.confidence * 100).toFixed(0) + '%): ' + actionCheck.reason);
      isValid = false;
    }

    // Check for time hallucinations (against current time)
    if (context.timezone) {
      const timeCheck = detectTimeHallucination(content, context.timezone);
      if (timeCheck.hasTimeHallucination) {
        // Check if it's a critical time math error
        const hasCriticalTimeMathError = timeCheck.wrongTimes.some(t =>
          t.includes('incorrect time calculation') ||
          t.includes('nonsensical time math')
        );

        if (hasCriticalTimeMathError) {
          issues.push('CRITICAL time hallucination: ' + timeCheck.wrongTimes.join(', '));
          isValid = false; // Block responses with wrong time math
        } else {
          issues.push('Time hallucination detected: ' + timeCheck.wrongTimes.join(', '));
          // Don't mark as invalid for minor time differences (will be auto-fixed)
        }
      }
    }

    // 🔥 Check for REMINDER FABRICATION — LLM making up reminder times/texts
    if (context.upcomingReminders && context.upcomingReminders.length > 0) {
      const reminderCheck = detectReminderFabrication(content, context.upcomingReminders);
      if (reminderCheck.hasFabrication) {
        issues.push('CRITICAL reminder fabrication: ' + reminderCheck.fabricatedReminders.join('; '));
        isValid = false; // BLOCK fabricated reminder info
      }
    }

    // Check for fact hallucinations
    if (context.userFacts && context.userFacts.length > 0) {
      const factCheck = detectFactHallucination(content, context.userFacts);
      if (factCheck.hasFactHallucination) {
        issues.push('Possible fact hallucination: ' + factCheck.suspiciousClaims.join('; '));
        // Warning only, not marking invalid (could be inference)
      }
    }

    // 🔥 Check for WEB SEARCH HALLUCINATION — LLM making up real-time info
    // (weather, news, prices, sports, etc.) without calling web_search
    if (context.userMessage) {
      const webSearchCheck = detectWebSearchHallucination(content, context.userMessage);
      if (webSearchCheck.isHallucination) {
        issues.push('CRITICAL web-search hallucination: ' + webSearchCheck.reasons.join('; '));
        isValid = false; // BLOCK fabricated real-time info
        // Store suggested query so forceToolCall can use it
        llmResponse._webSearchQuery = webSearchCheck.suggestedQuery;
      }
    }

    // 🔥 Check for HUMAN FACT HALLUCINATION — LLM making up claims about user's
    // location, schedule, preferences, health, emotions, relationships, finances,
    // knowledge, future, intent, numbers, or identity (categories D–O)
    if (context.userMessage) {
      const humanCheck = detectHumanFactHallucination(content, context.userFacts || [], context.userMessage);
      if (humanCheck.isHallucination) {
        issues.push('CRITICAL human-fact hallucination [' + humanCheck.categories.join(', ') + ']: ' + humanCheck.claims.join(' | '));
        isValid = false; // BLOCK fabricated human facts
        // Store for forceToolCall / fallback
        llmResponse._humanFactCategories = humanCheck.categories;
        llmResponse._humanFactClaims = humanCheck.claims;
      }
    }
  }

  // Validate tool calls
  if (llmResponse.type === 'tool') {
    if (!llmResponse.name) {
      issues.push('Tool call missing name');
      isValid = false;
    }
    if (!llmResponse.args || typeof llmResponse.args !== 'object') {
      issues.push('Tool call missing or invalid args');
      isValid = false;
    }
  }

  // ── Smart forceToolCall: match user intent instead of blindly forcing list_reminders ──
  let forceToolCall = null;

  if (!isValid) {
    const userIntent = detectUserCreateIntent(context.userMessage || '');

    if (issues.some(i => i.includes('reminder fabrication'))) {
      // If user was trying to CREATE a reminder, force create_reminder NOT list_reminders
      if (userIntent === 'create_reminder') {
        console.log('[Validator] 🎯 User wants to CREATE reminder — forcing create_reminder, not list_reminders');
        forceToolCall = { name: 'create_reminder', args: {} }; // LLM will need to fill args
      } else {
        // Only force list_reminders if user was NOT trying to create something
        forceToolCall = { name: 'list_reminders', args: {} };
      }
    } else if (issues.some(i => i.includes('Action hallucination'))) {
      // If user wanted to create something specific, force that tool
      if (userIntent === 'create_reminder') {
        console.log('[Validator] 🎯 Action hallucination on create_reminder intent — forcing create_reminder');
        forceToolCall = { name: 'create_reminder', args: {} };
      } else if (userIntent === 'create_event') {
        forceToolCall = { name: 'create_event', args: {} };
      } else if (userIntent === 'add_note') {
        forceToolCall = { name: 'add_note', args: {} };
      } else if (userIntent === 'web_search') {
        forceToolCall = { name: 'web_search', args: {} };
      }
      // If no specific intent matched, DON'T force a tool — let the fallback message handle it
    } else if (issues.some(i => i.includes('web-search hallucination'))) {
      // 🔥 LLM fabricated real-time info — force web_search with the user's original query
      const searchQuery = llmResponse._webSearchQuery || context.userMessage || '';
      console.log('[Validator] 🔍 Forcing web_search instead of hallucinated real-time info');
      console.log('[Validator]    Query: ' + searchQuery.slice(0, 100));
      forceToolCall = { name: 'web_search', args: { query: searchQuery } };
    } else if (issues.some(i => i.includes('human-fact hallucination'))) {
      // 🔥 LLM fabricated claims about the user's life — don't force a tool,
      // let generateFallbackResponse produce a safe neutral message.
      // Human facts can't be resolved by a tool call; the bot needs to admit it
      // doesn't know and ask instead of assuming.
      const categories = llmResponse._humanFactCategories || [];
      console.log('[Validator] 👤 Human-fact hallucination blocked — categories: ' + categories.join(', '));
      // No forceToolCall — fallback message will handle it
    }
  }

  return { isValid, issues, forceToolCall };
}

/**
 * Generate a safe fallback response when hallucination is detected.
 * 
 * @param {string} userMessage - the user's original message
 * @returns {string}
 */
function generateFallbackResponse(userMessage) {
  const lower = userMessage.toLowerCase();

  // ── If user is trying to CREATE a reminder, don't show the list ──
  const createIntent = detectUserCreateIntent(userMessage);
  if (createIntent === 'create_reminder') {
    return 'Maaf, saya tak dapat proses reminder tu. Boleh cuba lagi? Contoh: "Ingatkan saya beli barang pukul 6:00 ptg"';
  }
  if (createIntent === 'create_event') {
    return 'Maaf, saya tak dapat proses event tu. Boleh cuba lagi dengan format yang lebih jelas?';
  }
  if (createIntent === 'add_note') {
    return 'Maaf, saya tak dapat simpan nota tu. Boleh cuba lagi?';
  }
  if (createIntent === 'web_search') {
    return '🔍 Let me search for that...';
  }

  // 🔥 If asking about real-time info (weather, news, prices), trigger web_search
  const realTimePatterns = [
    /\b(cuaca|weather|hujan|rain|panas|ribut|storm|banjir|mendung|suhu|temperature)\b/i,
    /\b(berita|news|terkini|latest|headline|tular|viral|semasa)\b/i,
    /\b(harga|price|stock|saham|bitcoin|btc|crypto|eth|emas|minyak|ringgit)\b/i,
    /\b(bola|football|soccer|score|keputusan|perlawanan|match|liga|league)\b/i,
    /\b(presiden|president|pm\s*malaysia|perdana\s*menteri|pilihan\s*raya|election)\b/i,
  ];

  for (const pattern of realTimePatterns) {
    if (pattern.test(lower)) {
      return '🔍 Let me search for the latest info on that...';
    }
  }

  // If asking about reminders/reminder times → trigger list_reminders
  // Narrowed: only match when user is clearly asking ABOUT existing reminders
  if (/\b(?:list|show|senarai|apa|tunjuk|check|semak)\s*(?:reminder|peringatan|schedule|jadual)/i.test(lower) ||
    /\b(?:reminder\s*(?:saya|aku|ada|apa)|peringatan\s*(?:saya|aku|ada|apa)|upcoming)/i.test(lower)) {
    return 'Let me check your reminders for accurate times...';
  }

  // If asking about time
  if ((lower.includes('pukul') || lower.includes('jam') || lower.includes('time')) &&
    (lower.includes('berapa') || lower.includes('sekarang') || lower.includes('now') || lower.includes('what'))) {
    const now = new Date();
    const tz = process.env.TIMEZONE || 'UTC';
    const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
    const minute = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, minute: '2-digit' }).format(now), 10);
    const period = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    const minStr = minute.toString().padStart(2, '0');

    if (lower.includes('pukul') || lower.includes('jam')) {
      return 'Pukul ' + hour12 + ':' + minStr + ' ' + period + ' sekarang.';
    }
    return 'It\'s ' + hour12 + ':' + minStr + ' ' + period + ' now.';
  }

  // If trying to create/set something — guide user to be more specific
  if (lower.includes('remind') || lower.includes('ingatkan') ||
    (lower.includes('set') && (lower.includes('reminder') || lower.includes('event') || lower.includes('task')))) {
    return 'Saya perlukan masa yang spesifik untuk set reminder. Contoh: "Ingatkan saya meeting pukul 3:00 ptg"';
  }

  // 🔥 If the hallucination was about the user's personal life (human facts),
  // respond neutrally — admit we don't know, ask instead of assuming.
  if (/\b(you('re| are|r)|awak\s+(sedang|ada|ialah|adalah)|your\s+(home|house|office|schedule|budget|salary|health|feeling|mood|emotion|preference|favorite|friend|family|wife|husband|skill|experience|profession|job|goal)|awak\s+(suka|minat|gemar|benci|prefer|pilih|selalu|biasa|nak|mahu|rasa))\b/i.test(lower)) {
    // Pick language based on user's message
    if (/[a-zA-Z]{4,}/.test(lower) && !/\b(?:awak|aku|saya|ni|tu|nak|tak|lah|kan|pun|dah|ni)\b/i.test(lower)) {
      return "I shouldn't make assumptions about your personal life. Could you tell me more about what you're looking for?";
    }
    return 'Saya tak patut buat andaian tentang hidup awak. Boleh cerita lebih lanjut supaya saya boleh bantu dengan tepat?';
  }

  // Generic safe fallback
  return 'Saya nak pastikan saya faham betul-betul. Boleh jelaskan apa yang awak nak?';
}

/**
 * Validate cancel_reminder tool calls against available reminders.
 * Prevents LLM from cancelling non-existent or wrong reminders.
 * 
 * @param {object} toolCall - { type: 'tool', name: 'cancel_reminder', args: { reminder_id: number } }
 * @param {Array<{id:number, text:string}>} reminders - available reminders
 * @param {string} userMessage - original user request
 * @returns {{ isValid: boolean, error?: string, suggestion?: string }}
 */
function validateCancelReminder(toolCall, reminders, userMessage) {
  if (!toolCall || toolCall.name !== 'cancel_reminder') {
    return { isValid: true };
  }

  const requestedId = parseInt(toolCall.args?.reminder_id);
  if (isNaN(requestedId)) {
    return {
      isValid: false,
      error: 'Invalid reminder ID',
    };
  }

  // Check if reminder exists
  const reminderExists = reminders.some(r => r.id === requestedId);
  if (!reminderExists) {
    // Extract what user was looking for
    const lower = userMessage.toLowerCase();
    let searchTerm = '';

    // Try to extract the reminder description from user message
    const cancelMatch = lower.match(/cancel.*?(?:reminder)?\s+(?:#?\d+|[\w\s]+)/);
    if (cancelMatch) {
      searchTerm = cancelMatch[0].replace(/cancel|reminder|#/gi, '').trim();
    }

    // List available reminders
    let suggestion = '';
    if (reminders.length === 0) {
      suggestion = 'You don\'t have any reminders to cancel.';
    } else {
      suggestion = 'I don\'t see that reminder in your list. ';
      if (searchTerm) {
        suggestion += 'Couldn\'t find "' + searchTerm + '". ';
      }
      suggestion += 'You have: ' + reminders.slice(0, 5).map(r =>
        '#' + r.id + ' (' + r.text + ')'
      ).join(', ');
    }

    return {
      isValid: false,
      error: 'Reminder #' + requestedId + ' does not exist',
      suggestion,
    };
  }

  return { isValid: true };
}

// ── Fact Lock System ────────────────────────────────────────────────────────
// Classifies facts into three confidence tiers:
//   - verified:   backed by explicit user statement or tool execution
//   - inferred:   deduced from patterns, context, or related facts
//   - uncertain:  guessed, assumed, or low-confidence extraction
//
// The LLM is only allowed to ASSERT verified facts.
// Inferred facts must be hedged ("you might prefer...").
// Uncertain facts must be presented as questions ("do you...?").

const FACT_TIERS = Object.freeze({
  VERIFIED: 'verified',
  INFERRED: 'inferred',
  UNCERTAIN: 'uncertain',
});

/**
 * Classify a fact into a confidence tier based on its metadata.
 * 
 * @param {object} fact - { key, value, confidence?, importance?, source?, created_at?, mention_count? }
 * @returns {{tier: 'verified'|'inferred'|'uncertain', score: number, reason: string}}
 */
function classifyFact(fact) {
  let score = 0;
  const reasons = [];

  // ── Factor 1: Explicit confidence score ──────────────────────────────
  if (typeof fact.confidence === 'number') {
    score += fact.confidence * 40; // 0-40 points from confidence
    if (fact.confidence >= 0.9) reasons.push('high explicit confidence (' + fact.confidence + ')');
    else if (fact.confidence >= 0.7) reasons.push('moderate explicit confidence (' + fact.confidence + ')');
    else reasons.push('low explicit confidence (' + fact.confidence + ')');
  } else {
    score += 20; // default moderate confidence
    reasons.push('no explicit confidence score');
  }

  // ── Factor 2: Mention count (repeated mentions = more reliable) ──────
  const mentions = fact.mention_count || 1;
  if (mentions >= 5) {
    score += 25;
    reasons.push('mentioned ' + mentions + ' times');
  } else if (mentions >= 3) {
    score += 15;
    reasons.push('mentioned ' + mentions + ' times');
  } else if (mentions >= 2) {
    score += 8;
    reasons.push('mentioned ' + mentions + ' times');
  } else {
    score += 3;
    reasons.push('mentioned only once');
  }

  // ── Factor 3: Source of the fact ─────────────────────────────────────
  const source = (fact.source || '').toLowerCase();
  if (source === 'user_explicit') {
    score += 30;
    reasons.push('explicitly stated by user');
  } else if (source === 'user_implied') {
    score += 10;
    reasons.push('implied by user');
  } else if (source === 'extracted') {
    score += 15;
    reasons.push('LLM-extracted from conversation');
  } else if (source === 'inferred') {
    score += 5;
    reasons.push('inferred from patterns');
  } else if (source === 'tool') {
    score += 30;
    reasons.push('set via tool call');
  } else {
    score += 10;
    reasons.push('unknown source');
  }

  // ── Factor 4: Recency (newer facts = more reliable) ──────────────────
  if (fact.created_at) {
    const ageMs = Date.now() - new Date(fact.created_at).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays < 1) {
      score += 15;
      reasons.push('created today');
    } else if (ageDays < 7) {
      score += 10;
      reasons.push('created within a week');
    } else if (ageDays < 30) {
      score += 5;
      reasons.push('created within a month');
    } else {
      score += 1;
      reasons.push('older than a month');
    }
  }

  // ── Factor 5: Importance (more important = user cares more → likely more accurate) ──
  if (typeof fact.importance === 'number') {
    score += fact.importance * 10; // 0-10 points from importance
  }

  // ── Determine tier ───────────────────────────────────────────────────
  let tier;
  if (score >= 75) {
    tier = FACT_TIERS.VERIFIED;
  } else if (score >= 40) {
    tier = FACT_TIERS.INFERRED;
  } else {
    tier = FACT_TIERS.UNCERTAIN;
  }

  return {
    tier,
    score: Math.round(score),
    reason: reasons.join('; '),
  };
}

/**
 * Get the assertion level for a fact — how the bot should express this fact.
 * Returns phrasing guidance for the LLM.
 * 
 * @param {object} fact - the memory fact
 * @returns {{level: 'assert'|'hedge'|'question', guidance: string}}
 */
function getAssertionLevel(fact) {
  const { tier, score } = classifyFact(fact);

  switch (tier) {
    case FACT_TIERS.VERIFIED:
      return {
        level: 'assert',
        guidance: 'You can confidently state this fact. Use definitive language: "Your ' + fact.key + ' is ' + fact.value + '."',
      };
    case FACT_TIERS.INFERRED:
      return {
        level: 'hedge',
        guidance: 'Hedge this fact. Use cautious language: "Based on what you\'ve shared, ' + fact.key + ' seems to be ' + fact.value + '" or "You might prefer ' + fact.value + '."',
      };
    case FACT_TIERS.UNCERTAIN:
    default:
      return {
        level: 'question',
        guidance: 'Do NOT assert this fact. Present it as a question: "Is your ' + fact.key + ' ' + fact.value + '?" or "I\'m not sure — do you ' + fact.key + ' ' + fact.value + '?"',
      };
  }
}

/**
 * Tag facts with their tier and generate a fact-lock summary for the system prompt.
 * 
 * @param {Array<object>} facts - array of memory facts
 * @returns {{verifiedFacts: Array, inferredFacts: Array, uncertainFacts: Array, factLockPrompt: string}}
 */
function buildFactLockContext(facts = []) {
  const verifiedFacts = [];
  const inferredFacts = [];
  const uncertainFacts = [];

  for (const fact of facts) {
    const { tier } = classifyFact(fact);
    switch (tier) {
      case FACT_TIERS.VERIFIED:
        verifiedFacts.push(fact);
        break;
      case FACT_TIERS.INFERRED:
        inferredFacts.push(fact);
        break;
      case FACT_TIERS.UNCERTAIN:
        uncertainFacts.push(fact);
        break;
    }
  }

  let prompt = '';

  if (verifiedFacts.length > 0) {
    prompt += '✅ VERIFIED FACTS (you can ASSERT these confidently):\n';
    prompt += verifiedFacts.map(f => '  • ' + f.key + ': ' + f.value).join('\n') + '\n\n';
  }

  if (inferredFacts.length > 0) {
    prompt += '⚠️ INFERRED FACTS (you MUST HEDGE these — use "might", "seems", "based on patterns"):\n';
    prompt += inferredFacts.map(f => '  • ' + f.key + ': ' + f.value).join('\n') + '\n\n';
  }

  if (uncertainFacts.length > 0) {
    prompt += '❓ UNCERTAIN FACTS (you MUST present as QUESTIONS — "do you...?", "is your...?"):\n';
    prompt += uncertainFacts.map(f => '  • ' + f.key + ': ' + f.value).join('\n') + '\n\n';
  }

  return { verifiedFacts, inferredFacts, uncertainFacts, factLockPrompt: prompt };
}

/**
 * Resolve conflicts between two facts with the same key.
 * Uses confidence + recency + source to determine which fact to keep.
 * 
 * @param {object} existing - the existing fact in memory
 * @param {object} incoming - the new/incoming fact
 * @returns {{keep: 'existing'|'incoming', reason: string, mergedValue?: string}}
 */
function resolveFactConflict(existing, incoming) {
  const existingClass = classifyFact(existing);
  const incomingClass = classifyFact(incoming);

  // If incoming has much higher score → replace
  if (incomingClass.score >= existingClass.score + 15) {
    return {
      keep: 'incoming',
      reason: 'Incoming fact has significantly higher confidence (' +
        incomingClass.score + ' vs ' + existingClass.score + '): ' + incomingClass.reason,
    };
  }

  // If existing has much higher score → keep
  if (existingClass.score >= incomingClass.score + 15) {
    return {
      keep: 'existing',
      reason: 'Existing fact has significantly higher confidence (' +
        existingClass.score + ' vs ' + incomingClass.score + '): ' + existingClass.reason,
    };
  }

  // If scores are close → prefer more recent
  const existingAge = existing.created_at ? Date.now() - new Date(existing.created_at).getTime() : Infinity;
  const incomingAge = incoming.created_at ? Date.now() - new Date(incoming.created_at).getTime() : Infinity;

  if (incomingAge < existingAge) {
    return {
      keep: 'incoming',
      reason: 'Similar confidence but incoming is more recent (by ' +
        Math.round((existingAge - incomingAge) / (24 * 60 * 60 * 1000)) + ' days)',
    };
  }

  return {
    keep: 'existing',
    reason: 'Similar confidence and existing is more recent or same age',
  };
}

module.exports = {
  detectActionHallucination,
  detectTimeHallucination,
  detectFactHallucination,
  detectReminderFabrication,
  detectUserCreateIntent,
  detectWebSearchHallucination,
  detectHumanFactHallucination,
  validateLLMResponse,
  generateFallbackResponse,
  validateCancelReminder,
  // Fact Lock System
  FACT_TIERS,
  classifyFact,
  getAssertionLevel,
  buildFactLockContext,
  resolveFactConflict,
};
