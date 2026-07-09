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
  const { upcomingReminders = [], userMessage = '', facts = [] } = opts;

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

  // ── Full validation for all tiers ─────────────────────────────────
  // All tiers now use the same thorough validation since data is shared.
  const validation = validator.validateLLMResponse(normalized, {
    timezone: process.env.TIMEZONE || 'UTC',
    userFacts: facts,
    upcomingReminders: upcomingReminders,
    userMessage: userMessage,  // 🔥 Pass user message so validator can detect create intent
  });

  if (!validation.isValid && normalized.type === 'message') {
    console.warn('[Shared] ⚠️ Hallucination detected:', validation.issues.join('; '));
    if (validation.forceToolCall) {
      const forcedName = validation.forceToolCall.name;
      // 🔥 CRITICAL: Only force tool calls that have complete args (e.g., list_reminders).
      // For create_reminder/create_event/add_note/web_search with empty args,
      // let the hallucinated message pass through — the bot's retry mechanism
      // will catch the action keywords and re-prompt the LLM correctly.
      const hasEmptyArgs = !validation.forceToolCall.args || Object.keys(validation.forceToolCall.args).length === 0;
      const isCreateTool = ['create_reminder', 'create_event', 'add_note', 'web_search'].includes(forcedName);

      if (isCreateTool && hasEmptyArgs) {
        console.log('[Shared] ⚠️ Forced tool ' + forcedName + ' has empty args — passing hallucinated message through for bot retry');
        // Pass the original hallucinated message through — bot/index.js will handle retry
        return { result: normalized, wasValidated: true };
      }

      console.log('[Shared] 🔄 Forcing ' + forcedName + ' tool call instead of hallucinated message');
      return { result: { type: 'tool', name: forcedName, args: validation.forceToolCall.args }, wasValidated: true };
    }
    const fallback = validator.generateFallbackResponse(userMessage);
    return { result: { type: 'message', content: fallback }, wasValidated: true };
  }

  if (validation.issues.length > 0) {
    console.log('[Shared] Validation issues (non-critical):', validation.issues.join('; '));
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
/**
 * Try to parse XML-style tool calls that some LLMs output instead of JSON.
 * Handles formats like:
 *   <tool_call><function=create_event><parameter=title>Meeting</parameter>...</function></tool_call>
 *   <function=create_event><parameter=title>Meeting</parameter>...</function>
 *   <create_event><title>Meeting</title><time>2026-07-01T08:00:00</time></create_event>
 *
 * @param {string} rawText
 * @returns {object|null} normalized tool call or null if not XML
 */
function parseXmlToolCall(rawText) {
  // Pattern 1: <tool_call><function=NAME>...</function></tool_call>
  const tcMatch = rawText.match(/<tool_call>\s*<function\s*=\s*([\w-]+)>([\s\S]*?)<\/function\s*>\s*<\/tool_call>/i);
  if (tcMatch) {
    return parseXmlParams(tcMatch[1], tcMatch[2]);
  }

  // Pattern 2: <function=NAME>...</function> (no outer wrapper, optional spaces around =)
  const fnMatch = rawText.match(/<function\s*=\s*([\w-]+)>([\s\S]*?)<\/function\s*>/i);
  if (fnMatch) {
    return parseXmlParams(fnMatch[1], fnMatch[2]);
  }

  // Pattern 3: <TOOL_NAME><param>value</param>...</TOOL_NAME>
  const knownToolsRe = new RegExp('<(' + KNOWN_TOOLS.join('|') + ')>([\\s\\S]*?)</\\1>', 'i');
  const namedMatch = rawText.match(knownToolsRe);
  if (namedMatch) {
    return parseXmlParams(namedMatch[1], namedMatch[2]);
  }

  return null;
}

/**
 * Extract parameters from XML-style <parameter=KEY>VALUE</parameter> or <KEY>VALUE</KEY> blocks.
 * @param {string} toolName - the tool/function name
 * @param {string} innerXml - the inner XML content between function tags
 * @returns {object} normalized { type:'tool', name, args }
 */
function parseXmlParams(toolName, innerXml) {
  const args = {};

  // Pattern: <parameter=KEY>VALUE</parameter> (with optional spaces around =)
  const paramRe = /<parameter\s*=\s*(\w+)>([\s\S]*?)<\/parameter\s*>/gi;
  let m;
  while ((m = paramRe.exec(innerXml)) !== null) {
    args[m[1]] = m[2].trim();
  }

  // Pattern: <KEY>VALUE</KEY> (generic XML tags)
  if (Object.keys(args).length === 0) {
    const tagRe = /<(\w+)>([\s\S]*?)<\/\1>/gi;
    while ((m = tagRe.exec(innerXml)) !== null) {
      args[m[1]] = m[2].trim();
    }
  }

  // Normalize tool name through aliases
  const lower = toolName.toLowerCase().replace(/[_-]/g, '');
  let resolvedName = toolName;
  if (TOOL_ALIASES[lower]) {
    resolvedName = TOOL_ALIASES[lower];
  } else if (KNOWN_TOOLS.includes(toolName)) {
    resolvedName = toolName;
  } else {
    const fuzzy = KNOWN_TOOLS.find(t => t.replace(/[_-]/g, '') === lower);
    if (fuzzy) resolvedName = fuzzy;
  }

  if (!KNOWN_TOOLS.includes(resolvedName)) {
    console.log('[Shared] XML tool call with unknown tool:', toolName, '→ resolved:', resolvedName);
    return null;
  }

  // Convert numeric string params to numbers where appropriate
  for (const key of ['reminder_id', 'event_id', 'task_id', 'goal_id', 'duration_minutes']) {
    if (args[key] && /^\d+$/.test(args[key])) {
      args[key] = parseInt(args[key], 10);
    }
  }

  console.log('[Shared] 🔄 Parsed XML tool call: ' + resolvedName + ' ' + JSON.stringify(args).slice(0, 200));
  return { type: 'tool', name: resolvedName, args };
}

function parseAndValidate(rawText, opts = {}) {
  // ── Helper: sanitize raw text that looks like JSON ────────────────────
  const sanitizeRawText = (text) => {
    // If text looks like JSON, try to extract readable content
    if (/^\s*[\{\[]/.test(text) || /```(?:json)?[\s\S]*```/.test(text)) {
      // Try to parse as JSON
      try {
        const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        const parsed = JSON.parse(cleaned);
        const readable = extractReadableContent(parsed);
        if (readable) return readable;
      } catch { }
      // Try regex extraction as last resort
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          const readable = extractReadableContent(parsed);
          if (readable) return readable;
        } catch { }
      }
      // If it's JSON-like but unreadable, return safe fallback
      console.warn('[Shared] ⚠️ Raw response looks like JSON but could not extract content');
      return 'Maaf, saya ada masalah format response. Boleh tanya semula?';
    }
    return text;
  };

  // ── Try 1: strip markdown fences then parse ───────────────────────────
  try {
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    const normalized = normalizeLLMResponse(parsed);
    if (normalized) {
      const { result } = validateParsedResponse(normalized, opts);
      return result;
    }
    // Valid JSON but unrecognized structure — try to extract readable content
    console.log('[Shared] Valid JSON but unrecognized structure after normalization, extracting readable content');
    const readable = extractReadableContent(parsed);
    if (readable) {
      return { type: 'message', content: readable };
    }
    // Truly unrecoverable — return a safe fallback, NOT raw JSON
    console.warn('[Shared] ⚠️ Could not extract readable content from LLM response');
    return { type: 'message', content: 'Maaf, response saya tak dapat diproses. Boleh tanya semula?' };
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
        // 🔥 FIX: Regex-extracted JSON but unrecognized — try to extract readable content
        console.log('[Shared] Regex-extracted JSON but unrecognized structure, extracting readable content');
        const readable = extractReadableContent(extracted);
        if (readable) {
          return { type: 'message', content: readable };
        }
      } catch (_) {
        console.log('[Shared] Regex extraction found but JSON.parse failed');
      }
    }

    // ── Try 3: XML-style tool calls (some LLMs use <tool_call> format) ──
    const xmlResult = parseXmlToolCall(rawText);
    if (xmlResult) {
      const { result } = validateParsedResponse(xmlResult, opts);
      return result;
    }

    // ── Final fallback: sanitize raw text (prevent JSON leakage) ────────
    console.log('[Shared] No JSON or XML tool call found in response, sanitizing raw text');
    const sanitized = sanitizeRawText(rawText);
    return { type: 'message', content: sanitized };
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
  'generate_reflection',
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

/**
 * Extract readable content from an unrecognized JSON object.
 * Used as a last resort when normalizeLLMResponse returns null —
 * prevents raw JSON from being shown to the user.
 * Looks for keys that typically contain human-readable text.
 *
 * @param {object} parsed - JSON.parsed but unrecognized object
 * @returns {string|null} extracted content or null
 */
function extractReadableContent(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // Priority keys that commonly contain the main response text
  const priorityKeys = ['summary', 'answer', 'text', 'message', 'reply', 'response', 'content', 'description'];
  for (const key of priorityKeys) {
    if (parsed[key] && typeof parsed[key] === 'string' && parsed[key].trim().length > 0) {
      return parsed[key].trim();
    }
  }

  // If the object has any string value > 20 chars, use it
  for (const key of Object.keys(parsed)) {
    if (typeof parsed[key] === 'string' && parsed[key].length > 20) {
      return parsed[key];
    }
  }

  return null;
}

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

  // 🔥 Handle objects with "model" key FIRST (LLM describing itself — common hallucination pattern)
  // This must come BEFORE the generic extractableKeys to ensure complete reconstruction
  if (parsed.model && typeof parsed.model === 'string') {
    const parts = [];
    if (parsed.model) parts.push('Model: ' + parsed.model);
    if (parsed.provider) parts.push('Provider: ' + parsed.provider);
    if (parsed.description && typeof parsed.description === 'string') parts.push(parsed.description);
    if (parsed.capabilities) parts.push('Capabilities: ' + (Array.isArray(parsed.capabilities) ? parsed.capabilities.join(', ') : parsed.capabilities));
    if (parts.length > 0) {
      console.log('[Shared] 🔄 Reconstructed message from model-description JSON');
      return { type: 'message', content: parts.join('. ') };
    }
  }

  // Handle nested model_info, model_details, etc.
  for (const modelKey of ['model_info', 'model_details', 'ai_info', 'bot_info', 'system_info']) {
    if (parsed[modelKey] && typeof parsed[modelKey] === 'object' && !Array.isArray(parsed[modelKey])) {
      const info = parsed[modelKey];
      const parts = [];
      if (info.name) parts.push(info.name);
      if (info.model) parts.push(info.model);
      if (info.provider) parts.push('by ' + info.provider);
      if (info.description) parts.push(info.description);
      if (info.version) parts.push('v' + info.version);
      if (parts.length > 0) {
        console.log('[Shared] 🔄 Reconstructed message from ' + modelKey + ' JSON');
        return { type: 'message', content: parts.join('. ') };
      }
    }
  }

  // 🔥 Last resort: try to extract meaningful string content from any key
  // Prevents raw JSON from being shown to the user when the LLM deviates
  // from the expected {"type":"message","content":"..."} format.
  // Common LLM output patterns that should be handled:
  //   {"summary":"...", "sources":[...]} → extract "summary"
  //   {"answer":"...", "results":[...]} → extract "answer"
  //   {"text":"...", "data":{...}} → extract "text"
  //   {"model_info":{...}} → extract nested description or model name
  const extractableKeys = [
    'summary', 'answer', 'text', 'message', 'reply', 'response', 'content', 'description',
    'output', 'result', 'body', 'info', 'details', 'data', 'analysis',
  ];
  for (const key of extractableKeys) {
    const val = parsed[key];
    if (val && typeof val === 'string' && val.trim().length > 0) {
      console.log('[Shared] 🔄 Extracted content from key "' + key + '" — LLM used non-standard JSON format');
      return { type: 'message', content: val.trim() };
    }
    // Handle nested object with description/content field
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const subKey of ['description', 'content', 'text', 'message', 'summary', 'info', 'detail', 'reply', 'name', 'output', 'answer', 'body']) {
        if (val[subKey] && typeof val[subKey] === 'string' && val[subKey].trim().length > 0) {
          console.log('[Shared] 🔄 Extracted nested content from "' + key + '.' + subKey + '" — LLM used non-standard JSON format');
          return { type: 'message', content: val[subKey].trim() };
        }
      }
    }
  }

  // 🔥 Scan ALL keys for nested objects that contain readable strings
  // This catches deeply nested structures like {"data":{"info":{"description":"..."}}}
  for (const key of keys) {
    const val = parsed[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      // Recursively search one level deeper
      for (const subKey of Object.keys(val)) {
        const subVal = val[subKey];
        if (subVal && typeof subVal === 'string' && subVal.trim().length > 10) {
          console.log('[Shared] 🔄 Extracted content from "' + key + '.' + subKey + '" (deep scan)');
          return { type: 'message', content: subVal.trim() };
        }
        if (subVal && typeof subVal === 'object' && !Array.isArray(subVal)) {
          for (const deepKey of ['description', 'content', 'text', 'message', 'summary', 'info', 'detail', 'reply', 'name', 'output', 'answer', 'body']) {
            if (subVal[deepKey] && typeof subVal[deepKey] === 'string' && subVal[deepKey].trim().length > 0) {
              console.log('[Shared] 🔄 Extracted deep content from "' + key + '.' + subKey + '.' + deepKey + '"');
              return { type: 'message', content: subVal[deepKey].trim() };
            }
          }
        }
      }
    }
  }

  // If the object has ANY string value that looks like natural language (>15 chars)
  for (const key of keys) {
    if (typeof parsed[key] === 'string' && parsed[key].length > 15) {
      console.log('[Shared] 🔄 Extracted content from key "' + key + '" (fallback) — LLM used unexpected format');
      return { type: 'message', content: parsed[key] };
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
  // ── All tiers get the SAME data. Only prompt structure differs by tier. ──
  const executiveCtx = options.executiveContext || '';

  // ── Determine tier for prompt STRUCTURE (not data) ────────────────────────
  // executiveContext is always present now. Use a tier hint if provided.
  const tier = options.tier || (executiveCtx ? 'deep' : 'medium');

  // 🔥 In-memory prompt cache: burst messages within 15s reuse the same prompt
  // Cache key: userId + tier + 15-second time bucket
  const timeBucket = Math.floor(Date.now() / 15000);
  const cacheKey = userId + '|' + tier + '|' + timeBucket;
  const cachedPrompt = promptCache.get(cacheKey);
  if (cachedPrompt && (Date.now() - cachedPrompt.cachedAt) < PROMPT_CACHE_TTL_MS) {
    return cachedPrompt.prompt;
  }

  const factLines = facts.length
    ? facts.map(f => '- ' + f.key + ': ' + f.value).join('\n')
    : '(none yet)';

  let reminderLines = '';
  if (reminders && reminders.length > 0) {
    reminderLines = '\nCURRENT UPCOMING REMINDERS (use these exact IDs for cancel/update):\n' +
      reminders.map(r => {
        const t = fmt(r.remind_at, 'ddd, D MMM [at] h:mm A');
        const rec = r.recurrence ? ' [' + r.recurrence + ']' : '';
        return '- #' + r.id + ': "' + r.text + '" on ' + t + rec;
      }).join('\n') + '\n';
  }

  const peopleSection = peopleContext || '';

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

  // ── Time period for correct greetings (Malay) ───────────────────────────
  const currentHour = parseInt(new Intl.DateTimeFormat('en', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now), 10);
  let timePeriod;
  if (currentHour >= 5 && currentHour < 12) {
    timePeriod = 'pagi (morning)';
  } else if (currentHour >= 12 && currentHour < 14) {
    timePeriod = 'tengah hari (noon/afternoon)';
  } else if (currentHour >= 14 && currentHour < 19) {
    timePeriod = 'petang (evening)';
  } else {
    timePeriod = 'malam (night)';
  }

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
    '• Casual chat with NO action involved\n' +
    '🔥 JSON FORMAT ENFORCEMENT (READ 3 TIMES):\n' +
    'Your JSON MUST use EXACTLY these keys: "type", and either "content" (for messages) OR "name"+"args" (for tools).\n' +
    'You MUST NOT invent new keys like "model", "provider", "model_info", "capabilities", "source", "metadata", etc.\n' +
    'You MUST NOT output JSON objects with custom structures. ONLY the two formats listed above are valid.\n' +
    'A JSON like {"model":"Gemini","provider":"Google"} will BREAK the system and confuse the user.\n' +
    '🔥 If the user asks "what model are you using?" or similar meta questions about yourself:\n' +
    '  Answer with format B: {"type":"message","content":"Saya guna model AI terkini yang power dan laju!"}\n' +
    '  Do NOT output a JSON with model details. Just reply naturally in the "content" field.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 2: Anti-hallucination guardrails (medium + deep only)
  // ═══════════════════════════════════════════════════════════════════════
  const ANTI_HALLUCINATION_MEDIUM =
    '⛔ FORBIDDEN in "message" responses: "done", "created", "set", "saved", "cancelled", ' +
    '"I\'ve", "I\'ll", "dah set", "dah buat", success emojis (✅✓☑). ' +
    'These imply you performed an action. YOU CANNOT ACT. Use tool calls instead.\n\n';
  const ANTI_HALLUCINATION_FULL =
    '🚫 HALLUCINATION GUARD ────────────────────\n' +
    '⛔ YOU CANNOT PERFORM ACTIONS. Only REQUEST them via tool calls.\n' +
    '⛔ NEVER say: done, created, set, saved, cancelled, dah set, dah buat, siap dah, I\'ve, I\'ll, ✅✓☑\n' +
    '⛔ NEVER say: "Kejap aku cari", "Let me search", "Tunggu aku check" → use web_search tool\n' +
    '✅ When user wants anything done → output type:"tool", NEVER type:"message"\n' +
    '🔥 SEARCH: Unknown fact → web_search tool call. Acknowledgment message = USELESS.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 3: Context block (all tiers)
  // ═══════════════════════════════════════════════════════════════════════
  const contextBlock =
    '─────────────── CONTEXT ───────────────\n' +
    'You are ' + botName + ', a personal AI assistant on Telegram.\n' +
    personalityBlock +
    'Timezone: ' + timezone + ' | Today: ' + today + ' | Current time: ' + currentTime + ' | Day period: ' + timePeriod + '\n\n' +
    (executiveCtx ? executiveCtx + '\n' : '') +
    'User facts:\n' + factLines +
    peopleSection +
    reminderLines + '\n';

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
    '⏰ TIME ACCURACY ───────────────────────────\n' +
    'Use EXACT time from CONTEXT above. Never guess/round/invent.\n' +
    'If user asks time → get_current_time tool OR reply with exact context time only.\n' +
    '🔥 "Pukul 12:30 PM sekarang." ✅ | "Pukul 12:30 PM. Meeting tinggal 9 minit!" ❌ (don\'t mention reminders unasked)\n' +
    '🔥 DO NOT calculate time differences unless explicitly asked.\n' +
    '🔥 If you can\'t calculate correctly → just state the time, don\'t guess.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 6: Memory & facts (medium + deep only)
  // ═══════════════════════════════════════════════════════════════════════
  const MEMORY_MEDIUM =
    'Don\'t invent facts about the user. Only reference what\'s in User facts above.\n\n';
  const MEMORY_FULL =
    '📝 MEMORY ──────────────────────────────────\n' +
    'User facts above = ALL you know. Don\'t invent.\n' +
    '🔥 Unknown → "I don\'t have that info" or ask. Never say "you told me" unless in facts.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 6.5: Fact Lock System (deep only) — assertion levels
  // ═══════════════════════════════════════════════════════════════════════
  const FACT_LOCK_FULL =
    '🔒 FACT ASSERTION LEVELS ──────────────────\n' +
    '✅ VERIFIED → assert: "Your X is Y"\n' +
    '⚠️ INFERRED → hedge: "Based on what you shared, X seems Y"\n' +
    '❓ UNCERTAIN → question: "Is your X Y?"\n' +
    '🔥 Unsure → treat as UNCERTAIN. A question is better than a wrong assertion.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 6.6: Creative & Proactive Thinking (medium + deep)
  // ═══════════════════════════════════════════════════════════════════════
  const CREATIVITY_MEDIUM =
    '💡 Be creative and proactive. Reference past context. Build on previous exchanges.\n' +
    'Suggest relevant follow-ups naturally. Think like a helpful friend, not a robot.\n\n';
  const CREATIVITY_FULL =
    '🧠 THINKING ─────────────────────────────────\n' +
    '• Brainstorm alternatives, connect cross-domain ideas, use analogies.\n' +
    '• Reference past exchanges (see WORKING MEMORY above). Build on context.\n' +
    '• Anticipate next steps. Suggest logical follow-ups.\n' +
    '• Match user\'s tone/energy. Natural language, not robotic.\n' +
    '• Be creative in WORDS, never fabricate actions.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 6.7: Conversation Memory Bridge (medium + deep)
  // ═══════════════════════════════════════════════════════════════════════
  const MEMORY_BRIDGE =
    '🔗 MEMORY BRIDGE ───────────────────────────\n' +
    'WORKING MEMORY above = your recent context. USE IT.\n' +
    '• Last Exchange → tells you what JUST happened → reference it: "Tadi kita bincang X, kan?"\n' +
    '• Recent Topics → themes flowing in this convo → build on them naturally\n' +
    '• Conversation Flow → overall direction → stay on track\n' +
    '🔥 Don\'t start fresh each time. Show you remember.\n' +
    '🔥 Memory empty? Ask questions, don\'t pretend.\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 7: Action awareness (medium + deep only)
  // ═══════════════════════════════════════════════════════════════════════
  const ACTION_MEDIUM =
    'You CANNOT act — only request actions. Never use past tense ("I created", "dah set") ' +
    'or confirmation language ("Done!", "Siap!"). System executes tools after you respond.\n\n';
  const ACTION_FULL =
    '🎯 ACTION AWARENESS ────────────────────────\n' +
    'You CANNOT act. You REQUEST actions via tool calls.\n' +
    '🔥 NEVER: "I created", "dah set", "I\'ve done", "Done!", "Siap!"\n' +
    '🔥 System executes tools AFTER you. Translate intent → tool call.\n\n';

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
    'generate_reflection {} | set_config {key, value} | revert_config {key}\n\n';
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
    'get_current_time  → args: {} — returns the current date and time in the user\'s timezone\n' +
    'generate_reflection → args: {} — generates a daily reflection summary of today\'s conversations, patterns & facts\n\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION 9-12: Deep-only sections (reminder awareness, rules, tasks, time guessing)
  // ═══════════════════════════════════════════════════════════════════════
  const DEEP_ONLY =
    '📋 REMINDER RULES ─────────────────────────\n' +
    '• CURRENT UPCOMING REMINDERS above = ALL active reminders. Empty = none exist.\n' +
    '• cancel_reminder: MUST match reminder text to list above. Not found → MESSAGE reply, NOT tool call.\n' +
    '   ❌ \"Cancel gym\" but no gym in list → {\"type\":\"message\",\"content\":\"Tak jumpa reminder gym.\"}\n' +
    '   ✅ \"Cancel #2\" and #2 exists → {\"type\":\"tool\",\"name\":\"cancel_reminder\",\"args\":{\"reminder_id\":2}}\n' +
    '• NEVER fabricate reminder times. Use EXACT times from list. 6:36 → hallucination (users set round times).\n' +
    '• \"What reminders?\" → call list_reminders tool. NEVER write list yourself.\n' +
    '\n' +
    '⏰ RULES ──────────────────────────────────\n' +
    '• Times: ISO-8601 with ' + tzOffset + '. \"9pm\" → \"' + today + 'T21:00:00' + tzOffset + '\"\n' +
    '• No time specified → ASK user, don\'t guess. NEVER use current time as default.\n' +
    '• \"Change X to Y\" → update_reminder/update_event, NOT create.\n' +
    '• Recurrence: \"daily\", \"weekly\", \"weekdays\", or null.\n' +
    '• web_search: news, prices, weather, facts, real-time info.\n' +
    '• set_config: bot_name, bot_personality, morning_briefing_time, reflection_time, weekly_review_time, weather_location\n' +
    '• revert_config: same keys as set_config. Use when user wants to undo.\n' +
    '\n' +
    '📋 TASKS & GOALS ──────────────────────────\n' +
    'create_task {title, description?, priority?(\"high\"|\"medium\"|\"low\"), due_date?(YYYY-MM-DD), goal_id?}\n' +
    'update_task {task_id, ...} | start_task {task_id} | complete_task {task_id} | cancel_task {task_id} | list_tasks {status?}\n' +
    'create_goal {title, description?, target_date?} | update_goal {goal_id, ...} | complete_goal {goal_id} | abandon_goal {goal_id} | list_goals {}\n' +
    'save_relationship {name, relationship?, context?, notes?} | list_people {}\n' +
    'Task = work item (no time). Reminder = time ping. Goal = long-term target.\n' +
    '\"I want to...\" / \"I need to...\" without time → create_task, NOT create_reminder.\n';

  // ═══════════════════════════════════════════════════════════════════════
  // SECTION: Automated Features (medium + deep — LLM must know what's auto)
  // ═══════════════════════════════════════════════════════════════════════
  const AUTO_FEATURES =
    '─────────────── 🤖 AUTOMATED FEATURES (KNOW THIS — DO NOT LIE TO USER) ───────────────\n' +
    'The following features run AUTOMATICALLY on a schedule. Do NOT tell the user they are manual:\n' +
    '• 🌅 Morning Briefing — AUTO daily at configurable time (default 7:00 AM).\n' +
    '   Configurable via set_config key "morning_briefing_time" (24h HH:MM).\n' +
    '• 🧘 Daily Reflection — AUTO daily at configurable time (default 9:00 PM).\n' +
    '   Configurable via set_config key "reflection_time" (24h HH:MM).\n' +
    '• 💬 Proactive Check-ins — AUTO every 60 minutes. May send morning/evening\n' +
    '   check-ins, goal reminders, or general conversation starters based on timing.\n' +
    '• 📊 Weekly Review — AUTO every Sunday at configurable time (default 10:00 AM).\n' +
    '   Configurable via set_config key "weekly_review_time" (24h HH:MM).\n' +
    '🔥 When user asks "is X automatic?" or "auto ke?" — check this list. Do NOT guess.\n' +
    '🔥 If a feature is NOT listed here, it is MANUAL and requires user to request.\n\n';

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
      CREATIVITY_MEDIUM +
      MEMORY_BRIDGE +
      TOOLS_MEDIUM +
      AUTO_FEATURES;
  } else {
    // Deep: full prompt
    prompt = JSON_FULL +
      ANTI_HALLUCINATION_FULL +
      contextBlock +
      LANGUAGE_FULL +
      TIME_FULL +
      MEMORY_FULL +
      FACT_LOCK_FULL +
      CREATIVITY_FULL +
      MEMORY_BRIDGE +
      ACTION_FULL +
      TOOLS_FULL +
      AUTO_FEATURES +
      DEEP_ONLY;
  }

  // 🔥 Cache the assembled prompt (15s TTL for burst messages)
  promptCache.set(cacheKey, { prompt, cachedAt: Date.now() });

  return prompt;
}

module.exports = { buildSystemPrompt, normalizeLLMResponse, invalidateConfigCache, validateParsedResponse, parseAndValidate };
