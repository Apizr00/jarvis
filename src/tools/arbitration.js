// src/tools/arbitration.js
// ── Tool Arbitration Layer ──────────────────────────────────────────────────
//
// Sits between the LLM's tool call and the tool executor.
// Handles: conflict detection, priority ranking, fallback chaining,
// and dependency resolution.
//
// Flow: intent → tool candidates → ranking → execution plan
//
// Example scenarios:
//   - weather + search → pick more specific tool first
//   - search fails → fallback chain (web_search → get_briefing → "I don't know")
//   - create_reminder + add_note → run both, reminder first

const tools = require('./index');
const trace = require('../utils/trace');

// ── Tool Categories ────────────────────────────────────────────────────────

const TOOL_CATEGORIES = {
  REMINDER: ['create_reminder', 'update_reminder', 'cancel_reminder', 'list_reminders'],
  EVENT: ['create_event', 'update_event', 'cancel_event'],
  NOTE: ['add_note'],
  FACT: ['set_fact'],
  SEARCH: ['web_search'],
  TIME: ['get_current_time', 'get_today', 'get_briefing'],
  TASK: ['create_task', 'update_task', 'start_task', 'complete_task', 'cancel_task', 'list_tasks'],
  GOAL: ['create_goal', 'update_goal', 'complete_goal', 'abandon_goal', 'list_goals'],
  PEOPLE: ['save_relationship', 'list_people'],
  CONFIG: ['set_config', 'revert_config'],
  MISC: ['get_quote', 'get_weekly_review'],
};

// ── Tool Priority Weights ──────────────────────────────────────────────────
// Higher = run first. Used when multiple tools are candidates.

const TOOL_PRIORITY = {
  // User-facing actions (high priority — user explicitly asked)
  create_reminder: 100,
  create_event: 100,
  create_task: 95,
  create_goal: 95,
  add_note: 90,
  set_fact: 90,
  save_relationship: 85,

  // Modifications (medium-high)
  update_reminder: 80,
  update_event: 80,
  update_task: 75,
  update_goal: 75,
  cancel_reminder: 70,
  cancel_event: 70,
  cancel_task: 65,
  complete_task: 65,
  complete_goal: 65,

  // Read operations (medium)
  list_reminders: 50,
  list_tasks: 50,
  list_goals: 50,
  list_people: 50,
  get_today: 45,
  get_briefing: 45,

  // Search/time (lower — often auxiliary)
  web_search: 40,
  get_current_time: 35,
  get_quote: 30,
  get_weekly_review: 30,

  // Config (lowest — rarely user-intended)
  set_config: 20,
  revert_config: 15,
  abandon_goal: 10,
};

// ── Tool Conflicts ─────────────────────────────────────────────────────────
// Some tools should NOT run together or have ordering constraints.

const TOOL_CONFLICTS = {
  // cancel_reminder conflicts with update_reminder on same ID
  cancel_reminder: {
    conflictsWith: ['update_reminder'],
    resolution: 'run_cancel_last', // update first, then cancel (user probably changed mind)
  },
  // create + cancel on same "concept" = skip both, ask user
  create_reminder: {
    conflictsWith: ['cancel_reminder'],
    resolution: 'ask_user',
  },
};

// ── Fallback Chains ────────────────────────────────────────────────────────
// If a tool fails or returns empty, what to try next?

const FALLBACK_CHAINS = {
  web_search: ['get_briefing', 'get_quote'],        // search → briefing → quote
  get_briefing: ['get_today'],                       // briefing → today
  list_reminders: ['get_today'],                     // no reminders → today
  list_tasks: ['list_goals'],                        // no tasks → goals
  list_goals: ['get_briefing'],                      // no goals → briefing
};

// ── Tool Dependencies ──────────────────────────────────────────────────────
// Some tools need data from another tool to run.

const TOOL_DEPENDENCIES = {
  update_reminder: { needs: 'list_reminders', reason: 'need reminder ID to update' },
  cancel_reminder: { needs: 'list_reminders', reason: 'need reminder ID to cancel' },
  update_event: { needs: 'list_reminders', reason: 'need event ID (check reminders)' },
  update_task: { needs: 'list_tasks', reason: 'need task ID to update' },
  complete_task: { needs: 'list_tasks', reason: 'need task ID to complete' },
};

// ── 1. Conflict Detection ──────────────────────────────────────────────────

/**
 * Check if two tools conflict with each other.
 * @param {string} toolA
 * @param {string} toolB
 * @returns {{conflicts: boolean, resolution?: string, reason?: string}}
 */
function detectConflict(toolA, toolB) {
  if (toolA === toolB) return { conflicts: false };

  const configA = TOOL_CONFLICTS[toolA];
  const configB = TOOL_CONFLICTS[toolB];

  // Check A → B conflict
  if (configA && configA.conflictsWith.includes(toolB)) {
    return {
      conflicts: true,
      resolution: configA.resolution,
      reason: toolA + ' conflicts with ' + toolB,
    };
  }

  // Check B → A conflict
  if (configB && configB.conflictsWith.includes(toolA)) {
    return {
      conflicts: true,
      resolution: configB.resolution,
      reason: toolB + ' conflicts with ' + toolA,
    };
  }

  return { conflicts: false };
}

/**
 * Check if a set of tool calls have any conflicts.
 * @param {Array<{name: string, args: object}>} toolCalls
 * @returns {{hasConflicts: boolean, conflicts: Array, safeOrder: Array}}
 */
function resolveConflicts(toolCalls) {
  const conflicts = [];
  const safeOrder = [...toolCalls];

  for (let i = 0; i < toolCalls.length; i++) {
    for (let j = i + 1; j < toolCalls.length; j++) {
      const result = detectConflict(toolCalls[i].name, toolCalls[j].name);
      if (result.conflicts) {
        conflicts.push({
          toolA: toolCalls[i],
          toolB: toolCalls[j],
          ...result,
        });

        // Reorder based on resolution
        if (result.resolution === 'run_cancel_last') {
          // Move cancel to end
          const cancelIdx = toolCalls[i].name.startsWith('cancel') ? i : j;
          const [cancelCall] = safeOrder.splice(cancelIdx, 1);
          safeOrder.push(cancelCall);
        }
      }
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    safeOrder,
  };
}

// ── 2. Priority Ranking ────────────────────────────────────────────────────

/**
 * Rank tool candidates by priority score.
 * @param {Array<{name: string, args: object}>} toolCalls
 * @returns {Array<{name: string, args: object, priority: number, category: string}>}
 */
function rankTools(toolCalls) {
  return toolCalls
    .map(tc => {
      const priority = TOOL_PRIORITY[tc.name] || 50;
      const category = Object.entries(TOOL_CATEGORIES).find(
        ([, tools]) => tools.includes(tc.name)
      )?.[0] || 'MISC';

      return { ...tc, priority, category };
    })
    .sort((a, b) => b.priority - a.priority);
}

// ── 3. Fallback Chaining ───────────────────────────────────────────────────

/**
 * Get the fallback chain for a tool.
 * @param {string} toolName
 * @returns {string[]} ordered list of fallback tool names
 */
function getFallbackChain(toolName) {
  return FALLBACK_CHAINS[toolName] || [];
}

/**
 * Execute a tool with fallback chaining.
 * If the primary tool fails, tries each fallback in order.
 *
 * @param {string} userId
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<{result: any, toolUsed: string, fallbackUsed: boolean}>}
 */
async function executeWithFallback(userId, toolName, args) {
  const fallbackChain = getFallbackChain(toolName);
  let lastError = null;

  // Try primary tool
  try {
    const span = trace.startSpan('tool_execution', { userId, toolName });
    const result = await tools.executeTool(userId, { name: toolName, args });

    // Check if result indicates failure (empty, error, etc.)
    if (isResultFailure(result)) {
      lastError = new Error('Tool returned empty/failure result');
    } else {
      span.end({ success: true, fallback: false });
      trace.logToolCall(toolName, args, result, span.durationMs);
      return { result, toolUsed: toolName, fallbackUsed: false };
    }
  } catch (err) {
    lastError = err;
  }

  // Try fallbacks in order
  for (const fallbackTool of fallbackChain) {
    console.log('[Arbitration] 🔄 Fallback: ' + toolName + ' → ' + fallbackTool);
    try {
      const fallbackArgs = mapArgsForFallback(toolName, fallbackTool, args);
      const span = trace.startSpan('tool_execution_fallback', { userId, toolName: fallbackTool });
      const result = await tools.executeTool(userId, {
        name: fallbackTool,
        args: fallbackArgs,
      });

      if (!isResultFailure(result)) {
        span.end({ success: true, fallback: true, originalTool: toolName });
        trace.logToolCall(fallbackTool, fallbackArgs, result, span.durationMs);
        return { result, toolUsed: fallbackTool, fallbackUsed: true };
      }
    } catch (fallbackErr) {
      console.warn('[Arbitration] ⚠️ Fallback ' + fallbackTool + ' also failed:', fallbackErr.message);
    }
  }

  // All fallbacks exhausted — return graceful degradation
  const degradeMsg = generateDegradeMessage(toolName, lastError);
  return { result: degradeMsg, toolUsed: toolName, fallbackUsed: false, degraded: true };
}

/**
 * Check if a tool result indicates failure.
 */
function isResultFailure(result) {
  if (!result) return true;
  if (typeof result === 'string' && (
    result.includes('No reminders') ||
    result.includes('No tasks') ||
    result.includes('No goals') ||
    result.includes('No notes') ||
    result.includes('tidak jumpa') ||
    result.includes('not found') ||
    result.includes('no results')
  )) {
    return true;
  }
  if (result && result.error) return true;
  return false;
}

/**
 * Map arguments from the original tool to the fallback tool.
 */
function mapArgsForFallback(originalTool, fallbackTool, originalArgs) {
  // web_search query → get_briefing (no args needed)
  if (originalTool === 'web_search' && fallbackTool === 'get_briefing') {
    return {};
  }
  // Keep original args if compatible
  return originalArgs;
}

/**
 * Generate a graceful degradation message when all fallbacks fail.
 */
function generateDegradeMessage(toolName, error) {
  const messages = {
    web_search: 'I couldn\'t find results for that search right now. Try asking differently or I can check what\'s on your schedule instead.',
    list_reminders: 'I don\'t see any reminders at the moment. Want to set one?',
    list_tasks: 'No active tasks found. Want to create one?',
    list_goals: 'No goals tracked yet. Want to set a goal to work toward?',
  };

  return messages[toolName] || 'I wasn\'t able to complete that action. Could you try again or ask something else?';
}

// ── 4. Dependency Resolution ───────────────────────────────────────────────

/**
 * Check if a tool has unmet dependencies.
 * Returns the dependency tool to run first, or null if none.
 *
 * @param {string} toolName
 * @param {object} args
 * @returns {{needsDep: boolean, depTool?: string, depReason?: string}}
 */
function checkDependencies(toolName, args) {
  const dep = TOOL_DEPENDENCIES[toolName];
  if (!dep) return { needsDep: false };

  // If the tool call already has the needed ID, no dependency needed
  if (toolName === 'update_reminder' && args.reminder_id) {
    return { needsDep: false };
  }
  if (toolName === 'cancel_reminder' && args.reminder_id) {
    return { needsDep: false };
  }
  if ((toolName === 'update_task' || toolName === 'complete_task') && args.task_id) {
    return { needsDep: false };
  }

  return {
    needsDep: true,
    depTool: dep.needs,
    depReason: dep.reason,
  };
}

/**
 * Resolve dependencies by pre-running required tools.
 * @param {string} userId
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<{resolved: boolean, preResults?: Array, error?: string}>}
 */
async function resolveDependencies(userId, toolName, args) {
  const depCheck = checkDependencies(toolName, args);
  if (!depCheck.needsDep) return { resolved: true };

  console.log('[Arbitration] 🔗 Dependency: ' + toolName + ' needs ' + depCheck.depTool + ' (' + depCheck.depReason + ')');

  // Auto-resolve: run the dependency tool first
  try {
    const depResult = await tools.executeTool(userId, {
      name: depCheck.depTool,
      args: {},
    });

    return {
      resolved: true,
      preResults: [{ tool: depCheck.depTool, result: depResult }],
    };
  } catch (err) {
    return {
      resolved: false,
      error: 'Failed to resolve dependency ' + depCheck.depTool + ': ' + err.message,
    };
  }
}

// ── 5. Execution Plan ──────────────────────────────────────────────────────

/**
 * Build an execution plan from tool candidates.
 * Handles: ranking, conflict resolution, dependency checking, fallback setup.
 *
 * @param {string} userId
 * @param {Array<{name: string, args: object}>} toolCalls
 * @returns {Promise<{plan: Array, warnings: Array, stats: object}>}
 */
async function buildExecutionPlan(userId, toolCalls) {
  if (!toolCalls || toolCalls.length === 0) {
    return { plan: [], warnings: [], stats: { total: 0, conflicts: 0, dependencies: 0 } };
  }

  const warnings = [];
  let conflictsResolved = 0;
  let dependenciesResolved = 0;

  // Step 1: Rank by priority
  let ranked = rankTools(toolCalls);

  // Step 2: Check conflicts
  const conflictResult = resolveConflicts(ranked);
  if (conflictResult.hasConflicts) {
    conflictsResolved = conflictResult.conflicts.length;
    for (const c of conflictResult.conflicts) {
      warnings.push('Conflict: ' + c.reason + ' → ' + c.resolution);
    }
    ranked = conflictResult.safeOrder;
  }

  // Step 3: Check dependencies
  const plan = [];
  for (const tc of ranked) {
    const depCheck = checkDependencies(tc.name, tc.args);
    if (depCheck.needsDep) {
      dependenciesResolved++;
      warnings.push('Dependency: ' + tc.name + ' needs ' + depCheck.depTool);
      // Prepend dependency tool
      plan.push({
        name: depCheck.depTool,
        args: {},
        isDependency: true,
        for: tc.name,
        priority: TOOL_PRIORITY[depCheck.depTool] || 40,
      });
    }
    plan.push({ ...tc, isDependency: false });
  }

  // Step 4: Attach fallback chains
  for (const step of plan) {
    step.fallbackChain = getFallbackChain(step.name);
  }

  return {
    plan,
    warnings,
    stats: {
      total: plan.length,
      conflicts: conflictsResolved,
      dependencies: dependenciesResolved,
      categories: [...new Set(plan.map(p => p.category))],
    },
  };
}

// ── 6. Smart Execution ─────────────────────────────────────────────────────

/**
 * Execute a tool call with full arbitration:
 * dependency resolution → conflict checking → execution → fallback.
 *
 * This is the main entry point. Replace direct tools.executeTool() calls
 * with this for smarter execution.
 *
 * @param {string} userId
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<{result: any, toolUsed: string, fallbackUsed: boolean, degraded: boolean}>}
 */
async function executeSmart(userId, toolName, args) {
  console.log('[Arbitration] 🎯 Smart execute: ' + toolName);

  // Step 1: Resolve dependencies
  const depResult = await resolveDependencies(userId, toolName, args);
  if (!depResult.resolved) {
    return {
      result: 'I need more information to complete that. ' + depResult.error,
      toolUsed: toolName,
      fallbackUsed: false,
      degraded: true,
    };
  }

  // Step 2: Check for conflicts with recently executed tools
  // (would need a short-term execution log — simplified for now)

  // Step 3: Execute with fallback
  return executeWithFallback(userId, toolName, args);
}

module.exports = {
  TOOL_CATEGORIES,
  TOOL_PRIORITY,
  TOOL_CONFLICTS,
  FALLBACK_CHAINS,
  detectConflict,
  resolveConflicts,
  rankTools,
  getFallbackChain,
  executeWithFallback,
  checkDependencies,
  resolveDependencies,
  buildExecutionPlan,
  executeSmart,
  isResultFailure,
};
