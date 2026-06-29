// src/executive/index.js
// ── Executive Controller ────────────────────────────────────────────────────
//
// The "brain" that sits between the bot and LLM. It decides:
//
//   1. What does the user want?        → Intent Detection
//   2. What resources are needed?      → Needs Assessment
//   3. Which provider should handle?   → Provider Selection
//   4. What's the current context?     → Working Memory + World Model
//
// Three execution tiers:
//   ⚡ FAST   — greeting, simple question     → direct LLM (MiMo), no memory
//   🔄 MEDIUM — conversation, info request    → LLM + memory (MiMo)
//   🧠 DEEP   — task, planning, tools         → full pipeline (DeepSeek)
//
// Flow:
//   User → Executive.decide() → {tier, needs, provider, context}
//        → Executive.execute() → routes to fast/medium/deep handler
//        → Response

const { detectIntent } = require('../llm/intent');
const workingMemory = require('./working-memory');
const db = require('../db');
const memory = require('../memory');
const relationships = require('../memory/relationships');

// ── 1. World Model ──────────────────────────────────────────────────────────
// Tracks the user's current state — simpler and faster than full memory retrieval.
// Updated on every message.

const worldModel = new Map();

const WORLD_MODEL_DEFAULTS = {
  status: 'unknown',          // working, busy, free, sleeping
  currentProject: '',         // what they're building/working on
  interests: [],              // current interests/topics
  budget: '',                 // budget concern level
  lastTopic: '',              // last discussed topic
  messageCount: 0,
  lastActive: null,
};

function getWorldModel(userId) {
  if (!worldModel.has(userId)) {
    worldModel.set(userId, { ...WORLD_MODEL_DEFAULTS });
  }
  return worldModel.get(userId);
}

function updateWorldModel(userId, updates = {}) {
  const wm = getWorldModel(userId);
  Object.assign(wm, updates);
  wm.messageCount++;
  wm.lastActive = new Date().toISOString();
}

function formatWorldModelForPrompt(userId) {
  const wm = getWorldModel(userId);
  const parts = [];

  if (wm.status && wm.status !== 'unknown') parts.push('Status: ' + wm.status);
  if (wm.currentProject) parts.push('Project: ' + wm.currentProject);
  if (wm.interests.length > 0) parts.push('Interests: ' + wm.interests.slice(0, 3).join(', '));
  if (wm.budget) parts.push('Budget: ' + wm.budget);
  if (wm.lastTopic) parts.push('Last topic: ' + wm.lastTopic);

  return parts.length > 0 ? 'USER STATE ────────────────────────\n' + parts.join('\n') : '';
}

// ── 2. Needs Assessment ─────────────────────────────────────────────────────

/**
 * Determine what resources the executive needs to fulfill this request.
 * Based on intent tier + keyword heuristics.
 */
function assessNeeds(intent, userMessage) {
  const lower = userMessage.toLowerCase();

  // Default needs by tier
  const needs = {
    memory: false,
    tools: false,
    relationships: false,
    planning: false,
    internet: false,
    followUp: false,
    workingMemory: false,
    worldModel: false,
  };

  switch (intent.tier) {
    case 'fast':
      // Fast: nothing needed. Direct answer.
      needs.worldModel = true; // still update world model
      return needs;

    case 'medium':
      needs.memory = true;
      needs.relationships = true;
      needs.worldModel = true;

      // Check for internet-implied keywords
      if (/\b(berita|news|terkini|latest|trend|cuaca|weather|saham|stock|harga|price)\b/i.test(lower)) {
        needs.internet = true;
      }
      return needs;

    case 'deep':
      needs.memory = true;
      needs.tools = true;
      needs.relationships = true;
      needs.planning = true;
      needs.followUp = true;
      needs.workingMemory = true;
      needs.worldModel = true;

      // Check for internet-implied keywords
      if (/\b(cari|search|google|berita|news|terkini|research|kaji|check|semak)\b/i.test(lower)) {
        needs.internet = true;
      }
      return needs;

    default:
      return needs;
  }
}

// ── 3. Decision Engine ──────────────────────────────────────────────────────

/**
 * Main entry point: analyze the user's message and decide how to handle it.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @returns {Promise<{
 *   tier: 'fast'|'medium'|'deep',
 *   needs: object,
 *   provider: 'mimo'|'deepseek',
 *   intent: object,
 *   workingMemoryActive: boolean,
 *   worldModelState: object,
 *   reason: string
 * }>}
 */
async function decide(userId, userMessage) {
  // ── Step 1: Detect intent ──────────────────────────────────────────────
  const intent = detectIntent(userMessage);

  // ── Step 2: Check working memory — if user is mid-task, escalate to deep ──
  const wmActive = workingMemory.isActive(userId);
  if (wmActive && intent.tier === 'medium') {
    // User is mid-task but asking something casual? Keep medium.
    // Only escalate if the message relates to the active task.
    const wm = workingMemory.get(userId);
    const taskWords = [wm.currentGoal, wm.currentProblem]
      .filter(Boolean)
      .flatMap(s => s.toLowerCase().split(/\s+/));

    const overlap = taskWords.filter(w => userMessage.toLowerCase().includes(w)).length;
    if (overlap >= 2) {
      intent.tier = 'deep';
      intent.reason = 'mid-task continuation (working memory active)';
    }
  }

  // ── Step 3: Assess needs ───────────────────────────────────────────────
  const needs = assessNeeds(intent, userMessage);

  // ── Step 4: Select provider ────────────────────────────────────────────
  const provider = intent.tier === 'deep' ? 'deepseek' : 'mimo';

  // ── Step 5: Touch working memory (increments counter) ──────────────────
  workingMemory.touch(userId);

  // ── Step 6: Update world model (basic tracking) ────────────────────────
  updateWorldModel(userId, { lastTopic: userMessage.slice(0, 80) });

  return {
    tier: intent.tier,
    needs,
    provider,
    intent,
    workingMemoryActive: wmActive,
    workingMemoryState: wmActive ? workingMemory.get(userId) : null,
    worldModelState: getWorldModel(userId),
    reason: intent.reason,
  };
}

// ── 4. Context Builder ──────────────────────────────────────────────────────

/**
 * Build the executive context block that gets injected into the system prompt.
 * Only includes what the decision says is needed.
 *
 * @param {string} userId
 * @param {object} decision - from decide()
 * @param {string} userMessage - current user message
 * @returns {Promise<string>} context block to inject
 */
async function buildContext(userId, decision, userMessage) {
  const blocks = [];

  // ── Working Memory ─────────────────────────────────────────────────────
  if (decision.needs.workingMemory) {
    const wmBlock = workingMemory.formatForPrompt(userId);
    if (wmBlock) blocks.push(wmBlock);
  }

  // ── World Model ────────────────────────────────────────────────────────
  if (decision.needs.worldModel) {
    const worldBlock = formatWorldModelForPrompt(userId);
    if (worldBlock) blocks.push(worldBlock);
  }

  // ── Memory Facts ───────────────────────────────────────────────────────
  if (decision.needs.memory) {
    const facts = await memory.searchFacts(userId, userMessage);
    memory.recordFactAccess(userId, facts.map(f => f.key));

    if (facts.length > 0) {
      const factsBlock = 'MEMORY FACTS ──────────────────────\n' +
        facts.map(f => '• ' + f.key + ': ' + f.value).join('\n');
      blocks.push(factsBlock);
    }
  }

  // ── Relationships ──────────────────────────────────────────────────────
  if (decision.needs.relationships) {
    const peopleContext = await relationships.getPeopleContext(userId, userMessage, 5);
    if (peopleContext && peopleContext.trim()) {
      blocks.push(peopleContext);
    }
  }

  // ── Upcoming Reminders (only for deep tier) ────────────────────────────
  if (decision.tier === 'deep') {
    const upcomingReminders = await db.getUpcomingReminders(userId, 15);
    if (upcomingReminders.length > 0) {
      const reminderBlock = 'UPCOMING REMINDERS ────────────────\n' +
        upcomingReminders.map(r => '• #' + r.id + ': ' + r.text + ' at ' + r.remind_at).join('\n');
      blocks.push(reminderBlock);
    }
  }

  return blocks.join('\n\n');
}

// ── 5. Post-Processing Decision ─────────────────────────────────────────────

/**
 * After a response is generated, decide what post-processing is needed.
 * Returns recommended actions.
 */
function decidePostProcessing(decision, llmResponse) {
  const actions = {
    extractFacts: false,
    extractPeople: false,
    trackPatterns: true,       // always track
    updateWorkingMemory: false,
    scheduleReflection: false, // check if reflection needed
  };

  switch (decision.tier) {
    case 'fast':
      // Fast: only track patterns, nothing else
      break;

    case 'medium':
      actions.extractFacts = true;
      actions.extractPeople = true;
      break;

    case 'deep':
      actions.extractFacts = true;
      actions.extractPeople = true;
      actions.updateWorkingMemory = true;

      // Check if we should trigger reflection (every 10 deep messages)
      const wm = workingMemory.get('SYSTEM_REFLECTION_COUNTER');
      const count = (wm?.messageCount || 0) + 1;
      if (count >= 10) {
        actions.scheduleReflection = true;
      }
      break;
  }

  return actions;
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  decide,
  buildContext,
  decidePostProcessing,
  workingMemory,
  getWorldModel,
  updateWorldModel,
  formatWorldModelForPrompt,
};
