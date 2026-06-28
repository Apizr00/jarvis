// src/llm/shared.js
// Shared helpers used by all LLM providers
const { dayjs, fmt } = require('../utils/datetime');

// Known tool names — used for normalizing LLM responses that misuse the "type" field
const KNOWN_TOOLS = [
  'create_reminder', 'update_reminder', 'cancel_reminder', 'list_reminders',
  'create_event', 'add_note', 'get_today', 'get_briefing', 'get_quote', 'set_fact',
];

// Common LLM typos → correct tool name
const TOOL_ALIASES = {
  'createreminder': 'create_reminder',
  'cancelreminder': 'cancel_reminder',
  'updatereminder': 'update_reminder',
  'listreminders': 'list_reminders',
  'createevent': 'create_event',
  'addnote': 'add_note',
  'settoday': 'get_today',
  'getbriefing': 'get_briefing',
  'getquote': 'get_quote',
  'setfact': 'set_fact',
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

  return null;
}


/**
 * Build the system prompt for the LLM.
 * @param {Array<{key:string,value:string}>} facts - user memory facts
 * @param {string} timezone
 * @param {Array<{id:number,text:string,remind_at:string,recurrence:string|null}>} [reminders] - upcoming reminders
 */
function buildSystemPrompt(facts, timezone, reminders) {
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

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

  // Compute current UTC offset (e.g. "+08:00") for the configured timezone
  const offsetParts = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(new Date());
  const offsetStr = offsetParts.find(p => p.type === 'timeZoneName').value; // "GMT+08:00"
  const tzOffset = offsetStr.replace('GMT', ''); // "+08:00"

  // ── JSON-first prompt: the most critical instruction MUST come first ──
  return '🚨 CRITICAL: You are NOT a chatbot. You are a JSON API endpoint.\n' +
    'Your ENTIRE response must be a single valid JSON object. Nothing else. No markdown. No explanation.\n' +
    'If you output anything other than JSON, the system will BREAK and the user will be unhappy.\n\n' +
    'RESPONSE FORMAT (choose exactly ONE):\n\n' +
    'A) To perform an action → {\"type\":\"tool\",\"name\":\"TOOL_NAME\",\"args\":{...}}\n' +
    'B) To just reply → {\"type\":\"message\",\"content\":\"your short reply\"}\n\n' +
    '⚠️ WARNING: You have NO ability to create, cancel, update, save, or remember anything yourself.\n' +
    'If a user asks you to DO something, you MUST use format A (tool call). Format B (message) is ONLY for\n' +
    'pure conversation like greetings, answering factual questions, or casual chat.\n' +
    'NEVER use format B to say \"Done!\", \"Cancelled!\", \"Updated!\", \"Saved!\", or claim any action was taken.\n\n' +
    '─────────────── CONTEXT ───────────────\n' +
    'You are Jarvis, a personal AI assistant on Telegram.\n' +
    'Timezone: ' + timezone + ' | Today: ' + today + '\n\n' +
    'User facts:\n' + factLines +
    reminderLines + '\n' +
    '─────────────── TOOLS ───────────────\n' +
    'create_reminder   → args: { text, time(ISO-8601), recurrence? }\n' +
    'update_reminder   → args: { reminder_id, text?, time?, recurrence? }\n' +
    'cancel_reminder   → args: { reminder_id }\n' +
    'list_reminders    → args: {}\n' +
    'create_event      → args: { title, time(ISO-8601), duration_minutes? }\n' +
    'add_note          → args: { content }\n' +
    'get_today         → args: {}\n' +
    'get_briefing      → args: {}\n' +
    'get_quote         → args: {}\n' +
    'set_fact          → args: { key, value }\n\n' +
    '─────────────── RULES ───────────────\n' +
    '• For times: use ISO-8601 with ' + tzOffset + ' offset. Convert "at 9pm" → "' + today + 'T21:00:00' + tzOffset + '"\n' +
    '• For cancel/update: match user description to CURRENT UPCOMING REMINDERS above and use the exact #ID\n' +
    '• If user says \"change X to Y\", use update_reminder (NOT create_reminder)\n' +
    '• If user asks what reminders exist, use list_reminders\n' +
    '• Recurrence values: \"daily\", \"weekly\", \"weekdays\", or null to remove recurrence';
}

module.exports = { buildSystemPrompt, normalizeLLMResponse };
