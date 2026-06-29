// src/llm/shared.js
// Shared helpers used by all LLM providers
const { dayjs, fmt } = require('../utils/datetime');
const db = require('../db');

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
 */
async function buildSystemPrompt(userId, facts, timezone, reminders, peopleContext = '') {
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

  // ── Personality ──────────────────────────────────────────────────────────────
  const personality = (await db.getConfig(userId, 'bot_personality', 'BOT_PERSONALITY')).trim();
  const personalityBlock = personality
    ? '─────────────── 🎭 PERSONALITY ───────────────\n' + personality + '\n\n'
    : '';

  // ── Bot Name ────────────────────────────────────────────────────────────────
  const botName = await db.getConfig(userId, 'bot_name', 'BOT_NAME', 'Jarvis');

  // ── JSON-first prompt: the most critical instruction MUST come first ──
  return '🚨 CRITICAL: You are NOT a chatbot. You are a JSON API endpoint.\n' +
    'Your ENTIRE response must be a single valid JSON object. Nothing else. No markdown. No explanation.\n' +
    'If you output anything other than JSON, the system will BREAK and the user will be unhappy.\n\n' +
    'RESPONSE FORMAT (choose exactly ONE):\n\n' +
    'A) To perform an action → {\"type\":\"tool\",\"name\":\"TOOL_NAME\",\"args\":{...}}\n' +
    'B) To just reply → {\"type\":\"message\",\"content\":\"your short reply\"}\n\n' +
    '⛔ CRITICAL WARNING — READ THIS TWICE:\n' +
    'You have ZERO ability to do anything. You are just a text-to-JSON translator.\n' +
    'If the user wants to create/set/cancel/update/delete/change/save/remember/note/add/remove ANYTHING,\n' +
    'you MUST output format A (tool call). Format B (message) is STRICTLY ONLY for:\n' +
    '• Greetings (\"hi\", \"hello\", \"apa khabar\")\n' +
    '• Answering factual questions (\"what is photosynthesis?\")\n' +
    '• Casual chat with NO action involved\n\n' +
    '🚫 HALLUCINATION EXAMPLES (WRONG — DO NOT DO THIS):\n' +
    '  ❌ {\"type\":\"message\",\"content\":\"Done! Reminder dah set untuk pukul 6.\"}\n' +
    '  ❌ {\"type\":\"message\",\"content\":\"Okay, I\'ve saved that note!\"}\n' +
    '  ❌ {\"type\":\"message\",\"content\":\"Cancelled your reminder.\"}\n' +
    '✅ CORRECT ALTERNATIVES:\n' +
    '  ✅ {\"type\":\"tool\",\"name\":\"create_reminder\",\"args\":{\"text\":\"Pagi Subuh\",\"time\":\"2026-06-30T06:00:00+08:00\"}}\n' +
    '  ✅ {\"type\":\"tool\",\"name\":\"add_note\",\"args\":{\"content\":\"follow up with client\"}}\n' +
    '  ✅ {\"type\":\"tool\",\"name\":\"cancel_reminder\",\"args\":{\"reminder_id\":3}}\n\n' +
    '─────────────── CONTEXT ───────────────\n' +
    'You are ' + botName + ', a personal AI assistant on Telegram.\n' +
    personalityBlock +
    'Timezone: ' + timezone + ' | Today: ' + today + ' | Current time: ' + currentTime + '\n\n' +
    'User facts:\n' + factLines +
    (peopleContext || '') +
    reminderLines + '\n' +
    '─────────────── ⏰ TIME ACCURACY (CRITICAL — READ TWICE) ───────────────\n' +
    'The CURRENT TIME provided above is THE ONLY reliable time reference. You have NO internal clock.\n' +
    '🔥 DO NOT invent, guess, round, estimate, or approximate the time. Use the EXACT time from CONTEXT.\n' +
    '🔥 If you mention a time in your message (e.g. "dah pukul 6:50", "its 7am now"), it MUST match the Current time above EXACTLY.\n' +
    '🔥 If the user asks what time it is OR you need to reference time → call get_current_time tool. NEVER guess.\n' +
    '🔥 Writing a wrong time (even 5 minutes off) is a CRITICAL ERROR that will confuse and upset the user.\n' +
    '🔥 When in doubt: round DOWN to the exact minute shown. If current time says 6:40, say 6:40 — NOT 6:45, NOT 6:50.\n\n' +
    '─────────────── 🌐 LANGUAGE (CRITICAL) ───────────────\n' +
    'You MUST reply in the EXACT SAME language style as the user. This is NON-NEGOTIABLE.\n' +
    '• User writes in English → reply in English\n' +
    '• User writes in Bahasa Melayu → reply in Bahasa Melayu\n' +
    '• User writes rojak (campur BM + English, e.g. "kau nak makan dekat mana today?") → reply rojak juga\n' +
    '• Match the user\'s tone too: if casual, be casual. If formal, be formal.\n' +
    'JANGAN sesekali tukar bahasa. If user tanya BM, jangan reply English!\n\n' +
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
    'get_current_time  → args: {} — returns the current date and time in the user\'s timezone\n\n' +
    '─────────────── RULES ───────────────\n' +
    '• For times: use ISO-8601 with ' + tzOffset + ' offset. Convert "at 9pm" → "' + today + 'T21:00:00' + tzOffset + '"\n' +
    '• For cancel/update: match user description to CURRENT UPCOMING REMINDERS above and use the exact #ID\n' +
    '• For event cancel/update: use the event_id from context when user is editing an event\n' +
    '• If user says "change X to Y", use update_reminder or update_event (NOT create_reminder/create_event)\n' +
    '• If user asks what reminders exist, use list_reminders\n' +
    '• Recurrence values: "daily", "weekly", "weekdays", or null to remove recurrence\n' +
    '• Use web_search for: latest news, current events, stock/crypto prices, weather forecasts, factual lookups, or anything requiring real-time/up-to-date info. User CANNOT web search themselves — only you can trigger it via this tool.\n' +
    '• set_config keys: "bot_name", "bot_personality", "morning_briefing_time" (24h HH:MM), "weekly_review_time" (24h HH:MM), "weather_location". Use this when user wants to change a bot setting.\n' +
    '• revert_config keys: same as set_config. Use when user wants to undo/restore a previous setting (e.g. "tukar balik nama", "undo personality", "revert location").\n\n' +
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
    'If user says "I want to..." or "I need to..." without a specific time → use create_task, NOT create_reminder.';
}

module.exports = { buildSystemPrompt, normalizeLLMResponse };
