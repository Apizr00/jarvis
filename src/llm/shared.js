// src/llm/shared.js
// Shared helpers used by all LLM providers
const { dayjs, fmt } = require('../utils/datetime');
const db = require('../db');

// ── Shared validation (deduplicated from deepseek.js + mimo.js) ──────────────
// Both providers use this single function for response validation.
// Prevents drifting fixes between the two provider files.

let _validator = null;
function getValidator() {
  if (!_validator) _validator = require('./validator');
  return _validator;
}

/**
 * Validate and normalize a parsed LLM response.
 * Called by both deepseek.js and mimo.js after JSON parsing.
 * Handles: cancel_reminder check, hallucination detection, fallback generation.
 *
 * @param {object} normalized - already normalized response from normalizeLLMResponse()
 * @param {object} opts
 * @param {boolean} opts.minimal - if true, uses lightweight checks (fast tier)
 * @param {Array} opts.upcomingReminders - reminders for cancel validation
 * @param {string} opts.userMessage - original user message for context
 * @param {object} opts.facts - user facts for fact fabrication check
 * @returns {{result: object, wasValidated: boolean}}
 */
function validateParsedResponse(normalized, opts = {}) {
  const validator = getValidator();
  const { minimal, upcomingReminders = [], userMessage = '', facts = [] } = opts;

  // ── Always validate cancel_reminder calls ────────────────────────────
  if (normalized.type === 'tool' && normalized.name === 'cancel_reminder') {
    const cancelValidation = validator.validateCancelReminder(normalized, upcomingReminders, userMessage);
    if (!cancelValidation.isValid) {
      console.warn('[Shared] ⛔️ Blocked invalid cancel_reminder:', cancelValidation.error);
      return {
        result: { type: 'message', content: cancelValidation.suggestion || "I couldn't find that reminder." },
        wasValidated: true,
      };
    }
  }

  // ── Lightweight check for fast-tier: only catch blatant action claims ──
  if (minimal && normalized.type === 'message') {
    const actionCheck = validator.detectActionHallucination(normalized.content);
    if (actionCheck.isHallucination && actionCheck.confidence >= 0.85) {
      console.warn('[Shared] ⚠️ Fast-tier action hallucination blocked:', actionCheck.reason);
      return {
        result: { type: 'message', content: validator.generateFallbackResponse(userMessage) },
        wasValidated: true,
      };
    }
    // Fast tier: skip full validation, just do time fix later in bot layer
    return { result: normalized, wasValidated: true };
  }

  // ── Full validation for medium/deep tier ─────────────────────────────
  if (!minimal) {
    const validation = validator.validateLLMResponse(normalized, {
      timezone: process.env.TIMEZONE || 'UTC',
      userFacts: facts,
      upcomingReminders: upcomingReminders,
    });

    if (!validation.isValid && normalized.type === 'message') {
      console.warn('[Shared] ⚠️ Hallucination detected:', validation.issues.join('; '));
      if (validation.forceToolCall) {
        console.log('[Shared] 🔄 Forcing list_reminders tool call to get accurate times');
        return { result: { type: 'tool', name: 'list_reminders', args: {} }, wasValidated: true };
      }
      const fallback = validator.generateFallbackResponse(userMessage);
      return { result: { type: 'message', content: fallback }, wasValidated: true };
    }

    if (validation.issues.length > 0) {
      console.log('[Shared] Validation issues (non-critical):', validation.issues.join('; '));
    }
  }

  return { result: normalized, wasValidated: true };
}

/**
 * Parse raw LLM text into a validated response.
 * Full pipeline: JSON parse → normalize → validate.
 * Used by both chat() and chatStream() in both providers.
 *
 * @param {string} rawText - raw text from LLM
 * @param {object} opts - same as validateParsedResponse
 * @returns {object} the final response (type + content/name+args)
 */
function parseAndValidate(rawText, opts = {}) {
  // ── Try 1: strip markdown fences then parse ───────────────────────────
  try {
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    const normalized = normalizeLLMResponse(parsed);
    if (normalized) {
      const { result } = validateParsedResponse(normalized, opts);
      return result;
    }
    // Valid JSON but unrecognized structure — fall through to rawText
    console.log('[Shared] Valid JSON but unrecognized structure, falling back to rawText');
    return { type: 'message', content: rawText };
  } catch (e) {
    // ── Try 2: extract JSON object with regex ───────────────────────────
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[0]);
        const normalized = normalizeLLMResponse(extracted);
        if (normalized) {
          const { result } = validateParsedResponse(normalized, opts);
          return result;
        }
        console.log('[Shared] Regex-extracted JSON but unrecognized structure');
      } catch (_) {
        console.log('[Shared] Regex extraction found but JSON.parse failed');
      }
    } else {
      console.log('[Shared] No JSON object found in response, treating as plain message');
    }
    return { type: 'message', content: rawText };
  }
}

// ── Config cache (botName/personality rarely change, avoid DB hit every message) ──
const configCache = new Map(); // userId → { botName, personality, cachedAt }
const CONFIG_CACHE_TTL_MS = 5 * 60_000; // 5 min TTL

// ── System Prompt cache (short TTL — helps burst messages, invalidates on time change) ──
const promptCache = new Map(); // cacheKey → { prompt, cachedAt }
const PROMPT_CACHE_TTL_MS = 15_000; // 15 seconds — short enough to catch minute changes

function getCachedConfig(userId) {
  const entry = configCache.get(userId);
  if (entry && (Date.now() - entry.cachedAt) < CONFIG_CACHE_TTL_MS) {
    return entry;
  }
  configCache.delete(userId);
  return null;
}

function setCachedConfig(userId, botName, personality) {
  configCache.set(userId, { botName, personality, cachedAt: Date.now() });
}

/** Call when bot name or personality changes (e.g. /setname, /setpersonality) */
function invalidateConfigCache(userId) {
  configCache.delete(userId);
}

// Known tool names — used for normalizing LLM responses that misuse the "type" field
const KNOWN_TOOLS = [
  'create_reminder', 'update_reminder', 'cancel_reminder', 'list_reminders',
  'create_event', 'update_event', 'cancel_event',
  'add_note', 'get_today', 'get_briefing', 'get_quote', 'set_fact',
  'web_search', 'get_weekly_review', 'set_config', 'revert_config',
  'get_current_time',
  'create_task', 'update_task', 'start_task', 'complete_task', 'cancel_task', 'list_tasks',
  'create_goal', 'update_goal', 'complete_goal', 'abandon_goal', 'list_goals',
  'save_relationship', 'list_people',
];

// Common LLM typos → correct tool name
const TOOL_ALIASES = {
  'createreminder': 'create_reminder',
  'cancelreminder': 'cancel_reminder',
  'updatereminder': 'update_reminder',
  'listreminders': 'list_reminders',
  'createevent': 'create_event',
  'updateevent': 'update_event',
  'cancelevent': 'cancel_event',
  'addnote': 'add_note',
  'settoday': 'get_today',
  'getbriefing': 'get_briefing',
  'getquote': 'get_quote',
  'setfact': 'set_fact',
  'websearch': 'web_search',
  'searchweb': 'web_search',
  'getweeklyreview': 'get_weekly_review',
  'weeklyreview': 'get_weekly_review',
  'setconfig': 'set_config',
  'changesetting': 'set_config',
  'updatesetting': 'set_config',
  'revertconfig': 'revert_config',
  'revertsetting': 'revert_config',
  'undosetting': 'revert_config',
  'restore': 'revert_config',
  'gettime': 'get_current_time',
  'currenttime': 'get_current_time',
  'whattime': 'get_current_time',
  'timenow': 'get_current_time',
  'now': 'get_current_time',
  'time': 'get_current_time',
  'checktime': 'get_current_time',
  'createtask': 'create_task', 'addtask': 'create_task', 'newtask': 'create_task',
  'updatetask': 'update_task', 'edittask': 'update_task',
  'starttask': 'start_task', 'begintask': 'start_task',
  'completetask': 'complete_task', 'finishtask': 'complete_task', 'donetask': 'complete_task', 'markdone': 'complete_task',
  'canceltask': 'cancel_task', 'deletetask': 'cancel_task',
  'listtasks': 'list_tasks', 'showtasks': 'list_tasks', 'tasks': 'list_tasks',
  'creategoal': 'create_goal', 'addgoal': 'create_goal', 'newgoal': 'create_goal',
  'updategoal': 'update_goal', 'editgoal': 'update_goal',
  'completegoal': 'complete_goal', 'finishgoal': 'complete_goal', 'achievegoal': 'complete_goal',
  'abandongoal': 'abandon_goal', 'dropgoal': 'abandon_goal',
  'listgoals': 'list_goals', 'showgoals': 'list_goals', 'goals': 'list_goals',
  'saverelationship': 'save_relationship', 'rememberperson': 'save_relationship',
  'addperson': 'save_relationship', 'saveperson': 'save_relationship',
  'listpeople': 'list_people', 'showpeople': 'list_people', 'people': 'list_people',
};

/**
 * Parse and normalize an LLM's JSON response.
 * Handles common LLM mistakes like using the tool name as the "type" value
 * (e.g., {"type":"set_fact",...} instead of {"type":"tool","name":"set_fact",...}).
 *
 * @param {object} parsed - already JSON.parsed object
 * @returns {object|null} normalized {type, name?, content?, args?} or null if unparseable
 */
function normalizeLLMResponse(parsed) {
  // Already correct
  if (parsed.type === 'message' || parsed.type === 'tool') {
    return parsed;
  }

  // Has args → likely a tool call with wrong "type"
  if (parsed.args && typeof parsed.args === 'object') {
    let toolName = parsed.name || parsed.type || '';

    // Fix common typos/aliases
    const lower = toolName.toLowerCase().replace(/[_-]/g, '');
    if (TOOL_ALIASES[lower]) {
      toolName = TOOL_ALIASES[lower];
    }

    // Validate it's a known tool
    if (KNOWN_TOOLS.includes(toolName)) {
      return { type: 'tool', name: toolName, args: parsed.args };
    }

    // Fuzzy match: try to find closest known tool
    const fuzzy = KNOWN_TOOLS.find(t => t.replace(/[_-]/g, '') === lower);
    if (fuzzy) {
      return { type: 'tool', name: fuzzy, args: parsed.args };
    }
  }

  // Has "content" but wrong type → treat as message
  if (parsed.content && typeof parsed.content === 'string') {
    return { type: 'message', content: parsed.content };
  }

  // Edge case: the entire object IS a tool call (e.g. {"create_reminder": {...}})
  const keys = Object.keys(parsed);
  for (const key of keys) {
    const cleanKey = key.toLowerCase().replace(/[_-]/g, '');
    const match = KNOWN_TOOLS.find(t => t.replace(/[_-]/g, '') === cleanKey);
    if (match && typeof parsed[key] === 'object' && parsed[key] !== null) {
      return { type: 'tool', name: match, args: parsed[key] };
    }
  }

  // Edge case: extraction/memory response formats like {"people":[]} or {"facts":[]}
  // These are valid responses from auto-extraction LLM calls — treat as messages
  // so the extraction functions can parse them.
  if (keys.length === 1) {
    const onlyKey = keys[0].toLowerCase();
    if (onlyKey === 'people' || onlyKey === 'facts') {
      return { type: 'message', content: JSON.stringify(parsed) };
    }
  }

  return null;
}


/**
 * Build the system prompt for the LLM.
 * Reads bot_name and bot_personality from DB first, falls back to .env.
 * @param {string} userId
 * @param {Array<{key:string,value:string}>} facts - user memory facts
 * @param {string} timezone
 * @param {Array<{id:number,text:string,remind_at:string,recurrence:string|null}>} [reminders] - upcoming reminders
 * @param {string} [peopleContext] - pre-formatted people context lines (or empty string)
 * @param {{minimal?:boolean, executiveContext?:string}} [options]
 */
async function buildSystemPrompt(userId, facts, timezone, reminders, peopleContext = '', options = {}) {
  // ── Minimal mode: skip memory/reminders/people for fast-tier responses ──
  const minimal = options.minimal === true;
  const executiveCtx = options.executiveContext || '';

  // ── Determine tier for prompt sizing ──────────────────────────────────────
  const tier = minimal ? 'fast' : (executiveCtx ? 'deep' : 'medium');

  // 🔥 In-memory prompt cache: burst messages within 15s reuse the same prompt
  // Cache key: userId + tier + 15-second time bucket
  const timeBucket = Math.floor(Date.now() / 15000);
  const cacheKey = userId + '|' + tier + '|' + timeBucket;
  const cachedPrompt = promptCache.get(cacheKey);
  if (cachedPrompt && (Date.now() - cachedPrompt.cachedAt) < PROMPT_CACHE_TTL_MS) {
    return cachedPrompt.prompt;
  }

  const factLines = minimal
    ? '(skipped — fast response)'
    : (facts.length
      ? facts.map(f => '- ' + f.key + ': ' + f.value).join('\n')
      : '(none yet)');

  let reminderLines = '';
  if (!minimal && reminders && reminders.length > 0) {
    reminderLines = '\nCURRENT UPCOMING REMINDERS (use these exact IDs for cancel/update):\n' +
      reminders.map(r => {
        const t = fmt(r.remind_at, 'ddd, D MMM [at] h:mm A');
        const rec = r.recurrence ? ' [' + r.recurrence + ']' : '';
        return '- #' + r.id + ': "' + r.text + '" on ' + t + rec;
      }).join('\n') + '\n';
  }

  const peopleSection = minimal ? '' : (peopleContext || '');

  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);

  // Compute current UTC offset (e.g. "+08:00") for the configured timezone
  const offsetParts = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(now);
  const offsetStr = offsetParts.find(p => p.type === 'timeZoneName').value; // "GMT+08:00"
  const tzOffset = offsetStr.replace('GMT', ''); // "+08:00"

  // Current time in the configured timezone (e.g. "8:39 PM" or "20:39")
  const currentTime = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);

  // ── Personality + Bot Name (cached — rarely change, saves 2 DB hits per message) ──
  let botName, personality;
  const cached = getCachedConfig(userId);
  if (cached) {
    botName = cached.botName;
    personality = cached.personality;
  } else {
    const [p, n] = await Promise.all([
      db.getConfig(userId, 'bot_personality', 'BOT_PERSONALITY'),
      db.getConfig(userId, 'bot_name', 'BOT_NAME', 'Jarvis'),
    ]);
    personality = (p || '').trim();
    botName = n || 'Jarvis';
    setCachedConfig(userId, botName, personality);
  }

  const personalityBlock = personality
    ? '─────────────── 🎭 PERSONALITY ───────────────\n' + personality + '\n\n'
    : '';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 1: JSON format instruction (all tiers, varying verbosity)
  // ═══════════════════════════════════════════════════════════════════════
  const JSON_FAST =
    'Reply with ONE JSON object: {"type":"message","content":"your reply"} ' +
    'or {"type":"tool","name":"TOOL","args":{...}}.\n\n';
  const JSON_MEDIUM =
    '🚨 Reply ONLY with a single JSON object. No markdown, no explanation.\n' +
    '  {"type":"message","content":"your reply"} — for greetings, questions, chat\n' +
    '  {"type":"tool","name":"TOOL_NAME","args":{...}} — to request an action (set reminder, save note, etc.)\n' +
    '⛔ You CANNOT perform actions. You can only REQUEST them via tool calls.\n' +
    'If user wants to create/set/cancel/save/remember anything → MUST use tool call format.\n\n';
  const JSON_FULL =
    '🚨 CRITICAL: You are NOT a chatbot. You are a JSON API endpoint.\n' +
    'Your ENTIRE response must be a single valid JSON object. Nothing else. No markdown. No explanation.\n' +
    'If you output anything other than JSON, the system will BREAK and the user will be unhappy.\n\n' +
    'RESPONSE FORMAT (choose exactly ONE):\n\n' +
    'A) To perform an action → {"type":"tool","name":"TOOL_NAME","args":{...}}\n' +
    'B) To just reply → {"type":"message","content":"your short reply"}\n\n' +
    '⛔ CRITICAL WARNING — READ THIS FOUR TIMES:\n' +
    'You have ZERO ability to do anything. You CANNOT create, set, save, update, delete, or modify ANYTHING.\n' +
    'You are ONLY a text-to-JSON translator. You have NO database access. You have NO memory write access.\n' +
    'If the user wants to create/set/cancel/update/delete/change/save/remember/note/add/remove ANYTHING,\n' +
    'you MUST output format A (tool call). Format B (message) is STRICTLY ONLY for:\n' +
    '• Greetings ("hi", "hello", "apa khabar")\n' +
    '• Answering factual questions ("what is photosynthesis?")\n' +
    '• Asking clarifying questions ("What time do you want the reminder?")\n' +
    '• Casual chat with NO action involved\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 2: Anti-hallucination guardrails (medium + deep only)
  // ═══════════════════════════════════════════════════════════════════════
  const ANTI_HALLUCINATION_MEDIUM =
    '⛔ FORBIDDEN in "message" responses: "done", "created", "set", "saved", "cancelled", ' +
    '"I\'ve", "I\'ll", "dah set", "dah buat", success emojis (✅✓☑). ' +
    'These imply you performed an action. YOU CANNOT ACT. Use tool calls instead.\n\n';
  const ANTI_HALLUCINATION_FULL =
    '🚫 HALLUCINATION EXAMPLES (WRONG — YOU WILL BE PUNISHED FOR THESE):\n' +
    '  ❌ {"type":"message","content":"Done! Reminder dah set untuk pukul 6."}\n' +
    '  ❌ {"type":"message","content":"Okay, I\'ve saved that note!"}\n' +
    '  ❌ {"type":"message","content":"Cancelled your reminder."}\n' +
    '  ❌ {"type":"message","content":"✅ Reminder created for 6pm!"}\n' +
    '  ❌ {"type":"message","content":"Siap dah! Dah set reminder tu."}\n' +
    '  ❌ {"type":"message","content":"I\'ll remind you at 6pm."}\n' +
    '  ❌ {"type":"message","content":"Noted! I\'ll remember that."}\n' +
    '  ❌ {"type":"message","content":"Kejap, aku search dulu!"}\n' +
    '  ❌ {"type":"message","content":"Let me search for that..."}\n' +
    '  ❌ {"type":"message","content":"Sekejap, aku check dulu! 🔍"}\n' +
    '  ❌ {"type":"message","content":"Tunggu, aku cari dulu."}\n' +
    '✅ CORRECT ALTERNATIVES:\n' +
    '  ✅ {"type":"tool","name":"create_reminder","args":{"text":"Pagi Subuh","time":"2026-06-30T06:00:00+08:00"}}\n' +
    '  ✅ {"type":"tool","name":"add_note","args":{"content":"follow up with client"}}\n' +
    '  ✅ {"type":"tool","name":"cancel_reminder","args":{"reminder_id":3}}\n' +
    '  ✅ {"type":"tool","name":"web_search","args":{"query":"Perdana Menteri Malaysia 2026"}}\n\n' +
    '⚠️ FORBIDDEN WORDS IN MESSAGE RESPONSES:\n' +
    'If your response type is "message", you MUST NOT use these words/phrases:\n' +
    '• "done", "created", "set", "saved", "updated", "cancelled", "deleted", "added", "removed"\n' +
    '• "dah set", "dah create", "dah save", "dah tambah", "dah cancel", "dah delete"\n' +
    '• "i\'ve", "i have", "i will", "i just", "i\'ll", "all set", "got it"\n' +
    '• "✅", "✓", "☑" (success emojis)\n' +
    'These words mean you\'re claiming to have done an action. YOU CANNOT DO ACTIONS.\n' +
    'If you need to do an action, use format A (tool call), NEVER format B (message).\n\n' +
    '🔥 SEARCH RULE (CRITICAL — READ 5 TIMES):\n' +
    'When the user asks a question that needs web search (latest news, current facts, real-time info,\n' +
    'weather, stock/crypto prices, "who is", "what is the latest", "siapa", "apa berita", "cari", etc.),\n' +
    'you MUST output a web_search TOOL CALL. NEVER respond with a message like "let me search",\n' +
    '"kejap aku cari", "tunggu aku check", or any acknowledgment. The system handles the searching.\n' +
    'Your ONLY job is to output: {"type":"tool","name":"web_search","args":{"query":"..."}}\n' +
    '🔥 A search acknowledgment message is USELESS — the user gets NO information and has to ask again.\n' +
    '🔥 If user asks about something you don\'t know → web_search tool call, NOT "let me check".\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 3: Context block (all tiers)
  // ═══════════════════════════════════════════════════════════════════════
  const contextBlock =
    '─────────────── CONTEXT ───────────────\n' +
    'You are ' + botName + ', a personal AI assistant on Telegram.\n' +
    personalityBlock +
    'Timezone: ' + timezone + ' | Today: ' + today + ' | Current time: ' + currentTime + '\n\n' +
    (executiveCtx ? executiveCtx + '\n' : '') +
    (tier === 'fast' ? '' : 'User facts:\n' + factLines) +
    (tier === 'fast' ? '' : peopleSection) +
    (tier === 'fast' ? '' : reminderLines + '\n');

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 4: Language (all tiers)
  // ═══════════════════════════════════════════════════════════════════════
  const LANGUAGE_FAST =
    'Reply in the SAME language as the user. BM → BM. English → English. Rojak → Rojak.\n\n';
  const LANGUAGE_FULL =
    '─────────────── 🌐 LANGUAGE (CRITICAL) ───────────────\n' +
    'You MUST reply in the EXACT SAME language style as the user. This is NON-NEGOTIABLE.\n' +
    '• User writes in English → reply in English\n' +
    '• User writes in Bahasa Melayu → reply in Bahasa Melayu\n' +
    '• User writes rojak (campur BM + English, e.g. "kau nak makan dekat mana today?") → reply rojak juga\n' +
    '• Match the user\'s tone too: if casual, be casual. If formal, be formal.\n' +
    'JANGAN sesekali tukar bahasa. If user tanya BM, jangan reply English!\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 5: Time accuracy (medium + deep)
  // ═══════════════════════════════════════════════════════════════════════
  const TIME_MEDIUM =
    '⏰ Use ONLY the Current time from CONTEXT above. NEVER guess or invent times. ' +
    'If user asks for time → call get_current_time tool.\n\n';
  const TIME_FULL =
    '─────────────── ⏰ TIME ACCURACY (CRITICAL — READ TEN TIMES) ───────────────\n' +
    'The CURRENT TIME provided above is THE ONLY reliable time reference. You have NO internal clock.\n' +
    '🔥 DO NOT invent, guess, round, estimate, or approximate the time. Use the EXACT time from CONTEXT.\n' +
    '🔥 If you mention a time in your message (e.g. "dah pukul 6:50", "its 7am now"), it MUST match the Current time above EXACTLY.\n' +
    '🔥 If the user asks what time it is OR you need to reference time → call get_current_time tool. NEVER guess.\n' +
    '🔥 Writing a wrong time (even 1 minute off) is a CRITICAL ERROR that will confuse and upset the user.\n' +
    '🔥 When in doubt: use the exact time shown above. If current time says 6:40, say 6:40 — NOT 6:45, NOT 6:50, NOT "around 6:40".\n' +
    '🔥 NEVER round times. "About 7pm" is WRONG. "Roughly 6:30" is WRONG. Use exact time only.\n\n' +
    '⛔️ WHEN USER ASKS "WHAT TIME IS IT" — STRICT RULES:\n' +
    '🔥 If user asks ONLY for time ("pukul berapa?", "what time?", "masa sekarang?"):\n' +
    '   Option 1: Call get_current_time tool (PREFERRED)\n' +
    '   Option 2: Reply with JUST the time from Current time above, NOTHING ELSE\n' +
    '   ✅ CORRECT: {"type":"message","content":"Pukul 12:30 PM sekarang."}\n' +
    '   ✅ CORRECT: {"type":"tool","name":"get_current_time","args":{}}\n' +
    '   ❌ WRONG: {"type":"message","content":"Pukul 12:30 PM. Meeting kau pukul 12:30— tinggal 9 minit!"}\n' +
    '   ❌ WRONG: Mentioning reminders when NOT asked\n' +
    '\n' +
    '🔥 DO NOT mention upcoming reminders when user only asks for time.\n' +
    '🔥 DO NOT calculate time differences unless explicitly asked.\n' +
    '🔥 DO NOT say "tinggal X minit" or "X minutes left" unless user asks about a specific reminder.\n' +
    '\n' +
    '⛔️ TIME MATH — IF YOU MUST CALCULATE (only when user asks about reminders):\n' +
    '🔥 Current time: 12:30 PM, Reminder: 12:30 PM → "Reminder kau NOW!" or "Reminder kau dah sampai masa!"\n' +
    '🔥 Current time: 12:30 PM, Reminder: 12:31 PM → "Reminder kau dalam 1 minit lagi"\n' +
    '🔥 Current time: 12:30 PM, Reminder: 8:00 PM → "Reminder kau pukul 8:00 PM— tinggal 7 jam 30 minit"\n' +
    '🔥 If reminder time ≈ current time (within 1 minute), DON\'T say "tinggal 9 minit" — that\'s WRONG\n' +
    '🔥 If you cannot calculate correctly, DON\'T calculate. Just state the reminder time.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 6: Memory & facts (medium + deep only)
  // ═══════════════════════════════════════════════════════════════════════
  const MEMORY_MEDIUM =
    'Don\'t invent facts about the user. Only reference what\'s in User facts above.\n\n';
  const MEMORY_FULL =
    '─────────────── 📝 MEMORY & FACTS (CRITICAL) ───────────────\n' +
    'The "User facts" section above contains ALL the information you have about the user.\n' +
    '🔥 DO NOT invent or fabricate facts not listed there.\n' +
    '🔥 If the user asks about something not in User facts, respond with "I don\'t have that information" or ask them.\n' +
    '🔥 NEVER say "you told me" or "you mentioned" unless the fact is explicitly in the User facts section.\n' +
    '🔥 If User facts says "(none yet)", you have ZERO information about the user. Don\'t pretend otherwise.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 6.5: Fact Lock System (deep only) — assertion levels
  // ═══════════════════════════════════════════════════════════════════════
  const FACT_LOCK_FULL =
    '─────────────── 🔒 FACT LOCK SYSTEM (CRITICAL — READ 5 TIMES) ───────────────\n' +
    'Facts about the user are classified into THREE tiers. You MUST respect each tier:\n' +
    '\n' +
    '✅ VERIFIED FACTS — you can ASSERT these confidently:\n' +
    '   → Use definitive language: "Your X is Y", "You work at Z"\n' +
    '   → These are facts the user explicitly stated or were set via tools.\n' +
    '\n' +
    '⚠️ INFERRED FACTS — you MUST HEDGE these:\n' +
    '   → Use cautious language: "Based on what you\'ve shared, X seems to be Y"\n' +
    '   → Use qualifiers: "you might prefer...", "it appears that...", "typically..."\n' +
    '   → NEVER state an inferred fact as if it\'s certain.\n' +
    '\n' +
    '❓ UNCERTAIN FACTS — you MUST present as QUESTIONS:\n' +
    '   → "Is your X Y?", "Do you prefer Z?", "I\'m not sure — can you confirm...?"\n' +
    '   → NEVER assert an uncertain fact. The user will correct you and lose trust.\n' +
    '\n' +
    '🔥 EXAMPLES OF CORRECT ASSERTION LEVELS:\n' +
    '   ✅ Verified: "Your favorite color is blue." (user explicitly said this)\n' +
    '   ⚠️ Inferred: "Based on your schedule, you seem to prefer morning meetings."\n' +
    '   ❓ Uncertain: "Do you usually work out in the evenings?"\n' +
    '\n' +
    '🔥 If you\'re not sure which tier a fact belongs to → TREAT IT AS UNCERTAIN.\n' +
    '🔥 A hedged or questioned fact is better than a confidently wrong assertion.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 7: Action awareness (medium + deep only)
  // ═══════════════════════════════════════════════════════════════════════
  const ACTION_MEDIUM =
    'You CANNOT act — only request actions. Never use past tense ("I created", "dah set") ' +
    'or confirmation language ("Done!", "Siap!"). System executes tools after you respond.\n\n';
  const ACTION_FULL =
    '─────────────── 🎯 ACTION AWARENESS (CRITICAL) ───────────────\n' +
    'You CANNOT perform actions. You can only REQUEST actions via tool calls.\n' +
    '🔥 NEVER use past tense for actions ("I created", "I set", "dah buat", "dah set").\n' +
    '🔥 NEVER use present perfect ("I\'ve done", "dah siap", "sudah create").\n' +
    '🔥 NEVER use confirmation language ("Done!", "All set!", "Siap dah!").\n' +
    '🔥 The system executes tools AFTER you respond. You cannot know if they succeeded.\n' +
    '🔥 Your job: translate user intent to tool calls. The system\'s job: execute and confirm.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 8: Tools reference (deep full, medium compact)
  // ═══════════════════════════════════════════════════════════════════════
  const TOOLS_MEDIUM =
    '─────────────── TOOLS ───────────────\n' +
    'create_reminder {text, time(ISO-8601), recurrence?} | cancel_reminder {reminder_id}\n' +
    'update_reminder {reminder_id, text?, time?, recurrence?} | list_reminders {}\n' +
    'create_event {title, time, duration_minutes?} | update_event {event_id, ...}\n' +
    'cancel_event {event_id} | add_note {content} | set_fact {key, value}\n' +
    'get_today {} | get_briefing {} | get_quote {} | get_current_time {}\n' +
    'web_search {query} | list_tasks {} | list_goals {} | list_people {}\n' +
    'set_config {key, value} | revert_config {key}\n\n';
  const TOOLS_FULL =
    '─────────────── TOOLS ───────────────\n' +
    'create_reminder   → args: { text, time(ISO-8601), recurrence? }\n' +
    'update_reminder   → args: { reminder_id, text?, time?, recurrence? }\n' +
    'cancel_reminder   → args: { reminder_id }\n' +
    'list_reminders    → args: {}\n' +
    'create_event      → args: { title, time(ISO-8601), duration_minutes? }\n' +
    'update_event      → args: { event_id, title?, time?, duration_minutes? }\n' +
    'cancel_event      → args: { event_id }\n' +
    'add_note          → args: { content }\n' +
    'get_today         → args: {}\n' +
    'get_briefing      → args: {}\n' +
    'get_quote         → args: {}\n' +
    'set_fact          → args: { key, value }\n' +
    'web_search        → args: { query }\n' +
    'get_weekly_review → args: {}\n' +
    'set_config        → args: { key, value }\n' +
    'revert_config     → args: { key }\n\n' +
    'get_current_time  → args: {} — returns the current date and time in the user\'s timezone\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 9-12: Deep-only sections (reminder awareness, rules, tasks, time guessing)
  // ═══════════════════════════════════════════════════════════════════════
  const DEEP_ONLY =
    '─────────────── 📋 REMINDER AWARENESS (CRITICAL — READ 10 TIMES) ───────────────\n' +
    'The "CURRENT UPCOMING REMINDERS" section above shows ALL active reminders with their exact IDs.\n' +
    '🔥 If that section is empty, the user has NO reminders. Don\'t say they have reminders.\n' +
    '🔥 When user asks "do I have any reminders" or "apa ja reminder saya", check that section. If empty, say "No upcoming reminders".\n' +
    '\n' +
    '⛔️ CANCEL REMINDER RULES (CRITICAL — FOLLOW EXACTLY OR USER WILL BE ANGRY):\n' +
    '\n' +
    '🔴 BEFORE calling cancel_reminder tool:\n' +
    '   → You MUST read the CURRENT UPCOMING REMINDERS list above\n' +
    '   → You MUST check if the reminder the user mentioned is actually in that list\n' +
    '   → If NOT in the list, DO NOT call cancel_reminder tool. Instead respond with MESSAGE.\n' +
    '\n' +
    '🔴 WRONG EXAMPLE (DO NOT DO THIS):\n' +
    '   CURRENT UPCOMING REMINDERS:\n' +
    '   - #3: "Meeting" on Mon, 29 Jun at 12:45 PM\n' +
    '   \n' +
    '   User: "Cancel reminder gym malam ni"\n' +
    '   ❌ WRONG: {type:"tool", name:"cancel_reminder", args:{reminder_id:3}}\n' +
    '   Why wrong? There is NO "gym" in the reminders list! You cannot cancel it!\n' +
    '\n' +
    '🟢 CORRECT EXAMPLE:\n' +
    '   CURRENT UPCOMING REMINDERS:\n' +
    '   - #3: "Meeting" on Mon, 29 Jun at 12:45 PM\n' +
    '   \n' +
    '   User: "Cancel reminder gym malam ni"\n' +
    '   ✅ CORRECT: {type:"message", content:"Saya tak nampak reminder gym dalam list kau. Kau ada reminder Meeting je."}\n' +
    '   Why correct? You checked the list, saw NO "gym", so you responded with MESSAGE.\n' +
    '\n' +
    '1. User describes reminder (e.g., "cancel gym reminder", "cancel reminder gym", "buang reminder meeting"):\n' +
    '   Step 1: Look at CURRENT UPCOMING REMINDERS list above\n' +
    '   Step 2: Search for keywords in the reminder text (e.g., "gym", "meeting", "workout")\n' +
    '   Step 3a: If found exact match → use that reminder\'s #ID in cancel_reminder tool\n' +
    '   Step 3b: If NOT found → STOP. Do NOT call cancel_reminder. Respond with MESSAGE saying you don\'t see that reminder.\n' +
    '\n' +
    '2. User mentions reminder by ID (e.g., "cancel reminder #2", "cancel #2"):\n' +
    '   Step 1: Check if that exact #ID exists in CURRENT UPCOMING REMINDERS list\n' +
    '   Step 2a: If exists → use that ID in cancel_reminder tool\n' +
    '   Step 2b: If doesn\'t exist → STOP. Do NOT call cancel_reminder. Respond with MESSAGE.\n' +
    '\n' +
    '3. More examples:\n' +
    '   User: "Cancel reminder gym malam ni"\n' +
    '   CURRENT UPCOMING REMINDERS: #1 Meeting, #2 Call Mak\n' +
    '   ✅ CORRECT: {"type":"message","content":"Saya tak nampak reminder gym. Reminder kau sekarang: #1 Meeting, #2 Call Mak"}\n' +
    '   ❌ WRONG: {"type":"tool","name":"cancel_reminder","args":{"reminder_id":3}}\n' +
    '\n' +
    '   User: "Cancel reminder #2"\n' +
    '   CURRENT UPCOMING REMINDERS: #1 Meeting, #2 Call Mak\n' +
    '   ✅ CORRECT: {"type":"tool","name":"cancel_reminder","args":{"reminder_id":2}}\n' +
    '\n' +
    '   User: "Cancel reminder meeting"\n' +
    '   CURRENT UPCOMING REMINDERS: #1 Meeting at 3pm, #2 Call Mak\n' +
    '   ✅ CORRECT: {"type":"tool","name":"cancel_reminder","args":{"reminder_id":1}}\n' +
    '\n' +
    '🔥 DO NOT make up reminder IDs. DO NOT guess. Only use IDs explicitly listed in CURRENT UPCOMING REMINDERS.\n' +
    '🔥 If you cannot find a matching reminder, use type=message to tell the user, NOT type=tool.\n\n' +
    '─────────────── ⏰ REMINDER TIME ACCURACY (CRITICAL — READ 5 TIMES) ───────────────\n' +
    '🔥 The reminder times shown in CURRENT UPCOMING REMINDERS above are THE ONLY correct times. They come from the database.\n' +
    '🔥 YOU MUST NEVER change, round, or "correct" a reminder\'s time when mentioning it in a message.\n' +
    '🔥 If a reminder says "6:00 PM" in the list, you MUST say "6:00 PM" — NOT "6:36 PM", NOT "6:38 PM", NOT "around 6".\n' +
    '🔥 If a reminder says "6:00 AM" in the list, you MUST say "6:00 AM" — NOT "6:36 AM".\n' +
    '🔥 The AM/PM in the reminder list is ALREADY CORRECT. Do NOT change AM→PM or PM→AM.\n' +
    '🔥 When user asks "game pukul berapa?" or "what time is X?" — check the reminder list above. If the reminder exists, use its EXACT time.\n' +
    '🔥 If you\'re not sure about a reminder time → call list_reminders tool. NEVER guess.\n' +
    '🔥 Fabricating a reminder time is WORSE than saying "I don\'t know" — the user will miss their real event.\n' +
    '\n' +
    '⛔️ EXAMPLES OF TIME FABRICATION (WRONG — YOU WILL BE PUNISHED):\n' +
    '   CURRENT UPCOMING REMINDERS:\n' +
    '   - #4: "Netherlands vs Morocco" on Mon, 29 Jun at 8:00 PM\n' +
    '   - #5: "Makan malam" on Mon, 29 Jun at 8:00 PM\n' +
    '   \n' +
    '   User: "Game pukul 8 ka 6:36 ni?"\n' +
    '   ❌ WRONG: {"type":"message","content":"Makan malam — pukul 6:38 pm malam ni"}\n' +
    '   ❌ WRONG: {"type":"message","content":"#4 Netherlands — pukul 6:36 am, #5 Makan malam — pukul 6:36 pm"}\n' +
    '   Why wrong? The actual times are 8:00 PM! Where did 6:36 come from? YOU MADE IT UP.\n' +
    '   ✅ CORRECT: {"type":"message","content":"Game Netherlands vs Morocco pukul 8:00 PM. Makan malam pun pukul 8:00 PM."}\n' +
    '   ✅ CORRECT: {"type":"tool","name":"list_reminders","args":{}}\n' +
    '\n' +
    '⛔️ MORE TIME RULES:\n' +
    '• If two different reminders somehow show the same fabricated time (e.g., both 6:36), you are 100% hallucinating. Stop and check the list.\n' +
    '• The reminder times above are formatted as "h:mm AM/PM" — this is already the correct 12-hour format. Trust it.\n' +
    '• "6:36" is almost never the actual time of a user-set reminder. Users set reminders at round times like 6:00, 6:30, 8:00.\n' +
    '• If you see an oddly specific minute like :36 or :38 in your mind — you\'re hallucinating. Use the times from the list.\n\n' +
    '─────────────── RULES ───────────────\n' +
    '• For times: use ISO-8601 with ' + tzOffset + ' offset. Convert "at 9pm" → "' + today + 'T21:00:00' + tzOffset + '"\n' +
    '• For cancel/update: match user description to CURRENT UPCOMING REMINDERS above and use the exact #ID\n' +
    '• For event cancel/update: use the event_id from context when user is editing an event\n' +
    '• If user says "change X to Y", use update_reminder or update_event (NOT create_reminder/create_event)\n' +
    '• If user asks what reminders exist, use list_reminders tool IMMEDIATELY — DO NOT write the list yourself\n' +
    '⛔ NEVER write a reminder list yourself. ALWAYS call list_reminders tool to get accurate times.\n' +
    '⛔ The CURRENT UPCOMING REMINDERS section above is ONLY for ID reference (cancel/update), NOT for answering "what reminders do I have?"\n' +
    '• Recurrence values: "daily", "weekly", "weekdays", or null to remove recurrence\n' +
    '• Use web_search for: latest news, current events, stock/crypto prices, weather forecasts, factual lookups, or anything requiring real-time/up-to-date info. User CANNOT web search themselves — only you can trigger it via this tool.\n' +
    '• set_config keys: "bot_name", "bot_personality", "morning_briefing_time" (24h HH:MM), "weekly_review_time" (24h HH:MM), "weather_location". Use this when user wants to change a bot setting.\n' +
    '• revert_config keys: same as set_config. Use when user wants to undo/restore a previous setting (e.g. "tukar balik nama", "undo personality", "revert location").\n\n' +
    '⛔ CRITICAL — TIME GUESSING IS FORBIDDEN:\n' +
    '• If the user wants a reminder/event but does NOT specify a time → DO NOT invent one.\n' +
    '• Instead, reply with a message ASKING the user what time they want.\n' +
    '• Example: User says "remind me about the match" with NO time → reply asking "Pukul berapa nak remind?"\n' +
    '• Example: User says "add gym to calendar" with NO time → reply asking "What time for gym?"\n' +
    '• NEVER use the current time or a default time as a placeholder. That is hallucination.\n' +
    '• Only create_reminder/create_event when the user has clearly specified a time.\n\n' +
    '─────────────── TASKS & GOALS ───────────────\n' +
    'Task status flow: pending → start_task → in_progress → complete_task → done\n' +
    'create_task   → args: { title, description?, priority?("high"|"medium"|"low"), due_date?(YYYY-MM-DD), goal_id? }\n' +
    'update_task   → args: { task_id, title?, description?, priority?, due_date?, goal_id? }\n' +
    'start_task    → args: { task_id }\n' +
    'complete_task → args: { task_id }\n' +
    'cancel_task   → args: { task_id }\n' +
    'list_tasks    → args: { status? }\n' +
    'create_goal   → args: { title, description?, target_date?(YYYY-MM-DD) }\n' +
    'update_goal   → args: { goal_id, title?, description?, progress?(0-100), target_date? }\n' +
    'complete_goal → args: { goal_id }\n' +
    'abandon_goal  → args: { goal_id }\n' +
    'list_goals    → args: {}\n\n' +
    'save_relationship → args: { name, relationship?, context?, notes? }\n' +
    'list_people       → args: {} — list all remembered people\n\n' +
    'TASK vs REMINDER: Reminder = time-based ping ("remind me at 6pm"). Task = work item ("I need to finish report"). Goal = long-term target ("learn Rust").\n' +
    'If user says "I want to..." or "I need to..." without a specific time → use create_task, NOT create_reminder.\n';

  // ═══════════════════════════════════════════════════════════════════════
  // Assemble prompt by tier
  // ═══════════════════════════════════════════════════════════════════════
  let prompt;
  if (tier === 'fast') {
    prompt = JSON_FAST +
      contextBlock +
      LANGUAGE_FAST;
  } else if (tier === 'medium') {
    prompt = JSON_MEDIUM +
      ANTI_HALLUCINATION_MEDIUM +
      contextBlock +
      LANGUAGE_FULL +
      TIME_MEDIUM +
      MEMORY_MEDIUM +
      ACTION_MEDIUM +
      TOOLS_MEDIUM;
  } else {
    // Deep: full prompt
    prompt = JSON_FULL +
      ANTI_HALLUCINATION_FULL +
      contextBlock +
      LANGUAGE_FULL +
      TIME_FULL +
      MEMORY_FULL +
      FACT_LOCK_FULL +
      ACTION_FULL +
      TOOLS_FULL +
      DEEP_ONLY;
  }

  // 🔥 Cache the assembled prompt (15s TTL for burst messages)
  promptCache.set(cacheKey, { prompt, cachedAt: Date.now() });

  return prompt;
}

module.exports = { buildSystemPrompt, normalizeLLMResponse, invalidateConfigCache, validateParsedResponse, parseAndValidate };
