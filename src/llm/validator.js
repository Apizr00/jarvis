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

    // If more than 2 minutes off, it's wrong
    if (diffMins > 2) {
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

  // If reminder fabrication detected, suggest forcing list_reminders tool
  const forceToolCall = !isValid && issues.some(i => i.includes('reminder fabrication'))
    ? { name: 'list_reminders', args: {} }
    : null;

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

  // If asking about reminders/reminder times → trigger list_reminders
  // Narrowed: only match when user is clearly asking about reminder-related things
  if (lower.includes('remind') || lower.includes('peringatan') || lower.includes('ingatkan') ||
    (lower.includes('#') && /\d+/.test(lower))) {
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

  // If trying to create/set something
  if (lower.includes('remind') || lower.includes('ingatkan') ||
    (lower.includes('set') && (lower.includes('reminder') || lower.includes('event') || lower.includes('task')))) {
    return 'I need to confirm a few details first. What would you like me to do?';
  }

  // Generic safe fallback
  return 'I want to make sure I understand correctly. Could you clarify what you need?';
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
