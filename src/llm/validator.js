// src/llm/validator.js
// Anti-hallucination validator — catches LLM lies before they reach the user
const { dayjs, fmt } = require('../utils/datetime');

/**
 * Action verbs that indicate the bot claims to have done something.
 * If these appear in a "message" type response, it's likely a hallucination.
 */
const ACTION_VERBS = [
  // English
  'created', 'create', 'added', 'add', 'set', 'saved', 'saved', 'updated', 'update',
  'cancelled', 'cancel', 'deleted', 'delete', 'removed', 'remove', 'changed', 'change',
  'scheduled', 'schedule', 'reminded', 'remind', 'noted', 'note', 'recorded', 'record',
  'done', 'completed', 'finished', 'executed', 'performed', 'activated', 'enabled',
  'modified', 'edited', 'configured', 'stored', 'registered', 'cleared',
  // Malay/Indonesian
  'dah set', 'dah create', 'dah tambah', 'dah save', 'dah update', 'dah cancel',
  'dah delete', 'dah buang', 'dah tukar', 'dah ubah', 'dah buat', 'dah rekod',
  'dah simpan', 'dah jadual', 'dah schedule', 'sudah set', 'sudah create',
  'sudah tambah', 'sudah save', 'sudah cancel', 'sudah delete', 'sudah tukar',
  'telah set', 'telah create', 'telah tambah', 'telah save', 'telah cancel',
  'akan set', 'akan create', 'akan tambah', // "will set" - also a hallucination
  'setkan', 'tambahkan', 'simpankan', 'recordkan', 'cancelkan', 'deletekan',
];

/**
 * Phrases that indicate confirmation of an action.
 * These are red flags in a message-type response.
 */
const CONFIRMATION_PHRASES = [
  // English
  "i've", "i have", "i just", "i will", "done!", "all set", "got it",
  "reminder set", "reminder created", "event added", "event created",
  "note saved", "saved your", "updated your", "cancelled your",
  "deleted your", "removed your", "changed your", "scheduled for",
  // Malay
  "dah siap", "dah settle", "dah okay", "okay dah", "siap dah",
  "reminder dah set", "reminder dah create", "event dah tambah",
  "note dah save", "dah save note", "dah cancel reminder",
];

/**
 * Detect if a message-type LLM response contains hallucinated action claims.
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

  // Check for action verbs
  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb)) {
      confidence += 0.3;
      reasons.push('contains action verb: "' + verb + '"');
      if (confidence >= 0.9) break;
    }
  }

  // Check for confirmation phrases
  for (const phrase of CONFIRMATION_PHRASES) {
    if (lower.includes(phrase)) {
      confidence += 0.5;
      reasons.push('contains confirmation phrase: "' + phrase + '"');
      if (confidence >= 0.9) break;
    }
  }

  // Check for common patterns like "✅" or "done" at start
  if (/^(✅|✓|☑|🎉|done|okay|ok|siap|settle)/i.test(content.trim())) {
    confidence += 0.4;
    reasons.push('starts with confirmation emoji/word');
  }

  // Check for object references like "reminder", "event", "task" combined with action verbs
  const objectWords = ['reminder', 'event', 'task', 'note', 'goal', 'alarm', 'notification'];
  for (const obj of objectWords) {
    if (lower.includes(obj)) {
      // If object word is near an action verb, high confidence hallucination
      const hasActionNearby = ACTION_VERBS.some(verb => {
        const objIndex = lower.indexOf(obj);
        const verbIndex = lower.indexOf(verb);
        return Math.abs(objIndex - verbIndex) < 50; // within 50 chars
      });
      if (hasActionNearby) {
        confidence += 0.3;
        reasons.push('object word "' + obj + '" near action verb');
      }
    }
  }

  const isHallucination = confidence >= 0.7;

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
 * Validate an LLM response for hallucinations.
 * 
 * @param {{type: string, content?: string, name?: string, args?: object}} llmResponse
 * @param {object} context - { timezone, userFacts }
 * @returns {{isValid: boolean, issues: Array<string>, correctedResponse?: object}}
 */
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

    // Check for time hallucinations
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

  return { isValid, issues };
}

/**
 * Generate a safe fallback response when hallucination is detected.
 * 
 * @param {string} userMessage - the user's original message
 * @returns {string}
 */
function generateFallbackResponse(userMessage) {
  const lower = userMessage.toLowerCase();

  // If asking about time
  if (lower.includes('pukul') || lower.includes('jam') || lower.includes('time') ||
    lower.includes('berapa') && (lower.includes('sekarang') || lower.includes('now'))) {
    // Return simple time response without extras
    const now = new Date();
    const tz = process.env.TIMEZONE || 'UTC';
    const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
    const minute = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, minute: '2-digit' }).format(now), 10);
    const period = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;

    if (lower.includes('bahasa') || lower.includes('pukul') || lower.includes('jam')) {
      return 'Pukul ' + hour12 + ':' + minute.toString().padStart(2, '0') + ' ' + period + ' sekarang.';
    }
    return 'It\'s ' + hour12 + ':' + minute.toString().padStart(2, '0') + ' ' + period + ' now.';
  }

  // If trying to create/set something
  if (lower.includes('remind') || lower.includes('set') || lower.includes('create') ||
    lower.includes('add') || lower.includes('ingatkan') || lower.includes('buat')) {
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

module.exports = {
  detectActionHallucination,
  detectTimeHallucination,
  detectFactHallucination,
  validateLLMResponse,
  generateFallbackResponse,
  validateCancelReminder,
};
