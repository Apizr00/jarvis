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

const { detectIntentAdvanced } = require('./intent-engine');
const workingMemory = require('./working-memory');
const worldModelModule = require('./world-model');
const planner = require('./planner');
const evaluator = require('./evaluator');
const db = require('../db');
const memory = require('../memory');
const relationships = require('../memory/relationships');

// ── 1. World Model ──────────────────────────────────────────────────────────
// Delegated to world-model.js (Fasa 2 enhanced)

const worldModel = worldModelModule;

function getWorldModel(userId) { return worldModel.get(userId); }
function updateWorldModel(userId, updates) { return worldModel.update(userId, updates); }
function formatWorldModelForPrompt(userId) { return worldModel.formatForPrompt(userId); }

// ── 2. Needs Assessment ─────────────────────────────────────────────────────

/**
 * Determine what resources the executive needs to fulfill this request.
 * Based on intent tier + keyword heuristics.
 */
function assessNeeds(intent, userMessage) {
  const lower = userMessage.toLowerCase();
  const category = intent.category || '';

  // Default needs by tier + category
  const needs = {
    memory: false,
    tools: false,
    relationships: false,
    planning: false,
    internet: false,
    followUp: false,
    workingMemory: false,
    worldModel: false,
    domains: false,        // Fasa 3: structured domains
    selfEval: false,       // Fasa 5: self-evaluation
  };

  switch (intent.tier) {
    case 'fast':
      needs.worldModel = true;
      return needs;

    case 'medium':
      needs.memory = true;
      needs.relationships = true;
      needs.worldModel = true;
      needs.domains = true; // include domain context

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
      needs.domains = true;
      needs.selfEval = true; // evaluate response quality

      if (/\b(cari|search|google|berita|news|terkini|research|kaji|check|semak)\b/i.test(lower)) {
        needs.internet = true;
      }

      // Planning-specific
      if (category === 'task_planning' || category === 'task_goal' || category === 'task_project') {
        needs.planning = true;
      }
      return needs;

    default:
      needs.worldModel = true;
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
  // ── Step 1: Advanced intent detection (Fasa 1) ──────────────────────────
  const wm = workingMemory.get(userId);
  const context = {
    workingMemory: wm,
    recentMessages: [], // populated by bot if available
  };

  const intent = detectIntentAdvanced(userMessage, context);

  // ── Step 2: Context-aware escalation ────────────────────────────────────
  const wmActive = workingMemory.isActive(userId);
  if (intent.needsEscalation && intent.tier !== 'deep') {
    intent.tier = 'deep';
    intent.reason = intent.escalationReason || intent.reason;
  }

  // ── Step 3: Urgency override ───────────────────────────────────────────
  if (intent.isUrgent && intent.urgencyConfidence > 0.7 && intent.tier !== 'deep') {
    intent.tier = 'deep';
    intent.reason = 'urgent: ' + intent.reason;
  }

  // ── Step 4: Assess needs (Fasa 2 enhanced) ─────────────────────────────
  const needs = assessNeeds(intent, userMessage);

  // ── Step 5: Select provider ────────────────────────────────────────────
  const provider = intent.tier === 'deep' ? 'deepseek' : 'mimo';

  // ── Step 6: Touch working memory ─────────────────────────────────────
  workingMemory.touch(userId);

  // ── Step 7: Update world model (Fasa 2) ──────────────────────────────
  const worldUpdates = {
    lastTopic: userMessage.slice(0, 80),
    lastMood: intent.mood,
    lastCategory: intent.category,
    lastLanguage: intent.language,
  };
  updateWorldModel(userId, worldUpdates);

  // ── Step 8: Evaluate if proactive check needed (Fasa 5) ──────────────
  let proactiveSuggestion = null;
  if (intent.tier === 'deep' || intent.mood === 'motivated' || intent.category === 'task_goal') {
    proactiveSuggestion = evaluator.generateProactiveSuggestion(userId, wm, intent);
  }

  return {
    tier: intent.tier,
    needs,
    provider,
    intent,
    workingMemoryActive: wmActive,
    workingMemoryState: wmActive ? wm : null,
    worldModelState: getWorldModel(userId),
    reason: intent.reason,
    proactiveSuggestion,
    mood: intent.mood,
    language: intent.language,
    category: intent.category,
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
    trackPatterns: true,
    updateWorkingMemory: false,
    updateDomains: false,        // Fasa 3
    scheduleReflection: false,
    runSelfEval: false,          // Fasa 5
    suggestProactive: false,     // Fasa 5: proactive chat
  };

  switch (decision.tier) {
    case 'fast':
      break;

    case 'medium':
      actions.extractFacts = true;
      actions.extractPeople = true;
      actions.updateDomains = true;
      break;

    case 'deep':
      actions.extractFacts = true;
      actions.extractPeople = true;
      actions.updateWorkingMemory = true;
      actions.updateDomains = true;
      actions.runSelfEval = true;        // Fasa 5
      actions.suggestProactive = true;   // Fasa 5

      // Check if reflection should be triggered
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
  worldModel,
  planner,
  evaluator,
  getWorldModel,
  updateWorldModel,
  formatWorldModelForPrompt,
  detectIntentAdvanced,
};
