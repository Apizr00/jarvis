// src/executive/persistence.js
// ── Runtime State Persistence ───────────────────────────────────────────────
// Saves and restores critical in-memory executive state to DB so the bot
// can survive restarts without losing context.
//
// Modules persisted:
//   - working_memory  → currentGoal, currentProblem, solutions, nextSteps, etc.
//   - world_model     → status, activeDomain, mood, interests, time patterns
//   - lifecycle       → currentPhase, phaseHistory, message counts
//   - planner         → active plans with steps, dependencies, progress
//
// Checkpoint strategy:
//   - Auto-save every 5 minutes via setInterval
//   - Save on key events (plan created, phase transition, goal set)
//   - Load all states on bot startup

const db = require('../db');
const logger = require('../utils/logger');

// ── References to executive modules (set on init to avoid circular deps) ──
let workingMemory = null;
let worldModel = null;
let lifecycle = null;
let planner = null;

function initModules(wm, wmod, lc, plan) {
  workingMemory = wm;
  worldModel = wmod;
  lifecycle = lc;
  planner = plan;
}

// ── Auto-save interval ────────────────────────────────────────────────────
let autoSaveInterval = null;
const AUTO_SAVE_MS = 5 * 60 * 1000; // 5 minutes
const STATE_TYPES = ['working_memory', 'world_model', 'lifecycle', 'planner'];

/**
 * Save ALL runtime state for a user to DB.
 * Each module is responsible for providing serializable data.
 * Graceful: if one module fails, others still get saved.
 *
 * @param {string} userId
 * @returns {Promise<{saved: string[], failed: string[]}>}
 */
async function saveAll(userId) {
  if (!workingMemory || !worldModel || !lifecycle || !planner) {
    console.warn('[Persistence] ⚠️ Modules not initialized — skipping save');
    return { saved: [], failed: ['modules_not_init'] };
  }

  const results = { saved: [], failed: [] };

  // ── Working Memory ────────────────────────────────────────────────────
  try {
    if (typeof workingMemory.serialize === 'function') {
      const wmData = workingMemory.serialize(userId);
      if (wmData) {
        await db.saveBotState(userId, 'working_memory', wmData);
        results.saved.push('working_memory');
      }
    }
  } catch (err) {
    results.failed.push('working_memory');
    console.warn('[Persistence] Failed to save working_memory:', err.message);
  }

  // ── World Model ───────────────────────────────────────────────────────
  try {
    if (typeof worldModel.serialize === 'function') {
      const wmodData = worldModel.serialize(userId);
      if (wmodData) {
        await db.saveBotState(userId, 'world_model', wmodData);
        results.saved.push('world_model');
      }
    }
  } catch (err) {
    results.failed.push('world_model');
    console.warn('[Persistence] Failed to save world_model:', err.message);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  try {
    if (typeof lifecycle.serialize === 'function') {
      const lcData = lifecycle.serialize(userId);
      if (lcData) {
        await db.saveBotState(userId, 'lifecycle', lcData);
        results.saved.push('lifecycle');
      }
    }
  } catch (err) {
    results.failed.push('lifecycle');
    console.warn('[Persistence] Failed to save lifecycle:', err.message);
  }

  // ── Planner ───────────────────────────────────────────────────────────
  try {
    if (typeof planner.serialize === 'function') {
      const planData = planner.serialize(userId);
      if (planData) {
        await db.saveBotState(userId, 'planner', planData);
        results.saved.push('planner');
      }
    }
  } catch (err) {
    results.failed.push('planner');
    console.warn('[Persistence] Failed to save planner:', err.message);
  }

  if (results.saved.length > 0) {
    console.log('[Persistence] 💾 Saved states: ' + results.saved.join(', ') +
      (results.failed.length > 0 ? ' | Failed: ' + results.failed.join(', ') : ''));
  }

  return results;
}

/**
 * Load ALL runtime state for a user from DB and hydrate modules.
 * Safe to call on startup — gracefully handles missing data.
 *
 * @param {string} userId
 * @returns {Promise<{loaded: string[], skipped: string[], failed: string[]}>}
 */
async function loadAll(userId) {
  if (!workingMemory || !worldModel || !lifecycle || !planner) {
    console.warn('[Persistence] ⚠️ Modules not initialized — skipping load');
    return { loaded: [], skipped: [], failed: ['modules_not_init'] };
  }

  const results = { loaded: [], skipped: [], failed: [] };

  let states;
  try {
    states = await db.loadAllBotStates(userId);
  } catch (err) {
    console.warn('[Persistence] Failed to load states from DB:', err.message);
    results.failed = STATE_TYPES;
    return results;
  }

  // ── Working Memory ────────────────────────────────────────────────────
  try {
    const wmData = states['working_memory'];
    if (wmData && typeof workingMemory.hydrate === 'function') {
      workingMemory.hydrate(userId, wmData);
      results.loaded.push('working_memory');
    } else {
      results.skipped.push('working_memory');
    }
  } catch (err) {
    results.failed.push('working_memory');
    console.warn('[Persistence] Failed to hydrate working_memory:', err.message);
  }

  // ── World Model ───────────────────────────────────────────────────────
  try {
    const wmodData = states['world_model'];
    if (wmodData && typeof worldModel.hydrate === 'function') {
      worldModel.hydrate(userId, wmodData);
      results.loaded.push('world_model');
    } else {
      results.skipped.push('world_model');
    }
  } catch (err) {
    results.failed.push('world_model');
    console.warn('[Persistence] Failed to hydrate world_model:', err.message);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  try {
    const lcData = states['lifecycle'];
    if (lcData && typeof lifecycle.hydrate === 'function') {
      lifecycle.hydrate(userId, lcData);
      results.loaded.push('lifecycle');
    } else {
      results.skipped.push('lifecycle');
    }
  } catch (err) {
    results.failed.push('lifecycle');
    console.warn('[Persistence] Failed to hydrate lifecycle:', err.message);
  }

  // ── Planner ───────────────────────────────────────────────────────────
  try {
    const planData = states['planner'];
    if (planData && typeof planner.hydrate === 'function') {
      planner.hydrate(userId, planData);
      results.loaded.push('planner');
    } else {
      results.skipped.push('planner');
    }
  } catch (err) {
    results.failed.push('planner');
    console.warn('[Persistence] Failed to hydrate planner:', err.message);
  }

  if (results.loaded.length > 0) {
    console.log('[Persistence] 📥 Loaded states: ' + results.loaded.join(', ') +
      (results.skipped.length > 0 ? ' | Skipped (no data): ' + results.skipped.join(', ') : '') +
      (results.failed.length > 0 ? ' | Failed: ' + results.failed.join(', ') : ''));
  }

  return results;
}

/**
 * Save state for a single module (called on key events).
 * @param {string} userId
 * @param {string} stateType - 'working_memory' | 'world_model' | 'lifecycle' | 'planner'
 */
async function saveOne(userId, stateType) {
  const moduleMap = {
    working_memory: workingMemory,
    world_model: worldModel,
    lifecycle: lifecycle,
    planner: planner,
  };

  const mod = moduleMap[stateType];
  if (!mod || typeof mod.serialize !== 'function') return;

  try {
    const data = mod.serialize(userId);
    if (data) {
      await db.saveBotState(userId, stateType, data);
    }
  } catch (err) {
    console.warn('[Persistence] Failed to save ' + stateType + ':', err.message);
  }
}

/**
 * Start automatic checkpointing for a user.
 * Saves all states every AUTO_SAVE_MS (5 minutes).
 *
 * @param {string} userId
 */
function startAutoSave(userId) {
  if (autoSaveInterval) {
    // Already running — just log that this user is tracked
    return;
  }

  autoSaveInterval = setInterval(async () => {
    try {
      await saveAll(userId);
    } catch (err) {
      console.warn('[Persistence] Auto-save error:', err.message);
    }
  }, AUTO_SAVE_MS);

  // Don't prevent Node from exiting
  if (autoSaveInterval.unref) {
    autoSaveInterval.unref();
  }

  console.log('[Persistence] ⏱️ Auto-save started (every ' + (AUTO_SAVE_MS / 60000) + ' min)');
}

/**
 * Stop auto-save and perform a final checkpoint.
 * @param {string} userId
 */
async function stopAutoSave(userId) {
  if (autoSaveInterval) {
    clearInterval(autoSaveInterval);
    autoSaveInterval = null;
  }

  // Final save before shutdown
  console.log('[Persistence] 🔚 Performing final checkpoint...');
  await saveAll(userId);
}

/**
 * Get a summary of what's currently persisted for a user.
 * @param {string} userId
 * @returns {Promise<{states: string[], lastSaved: object}>}
 */
async function getStatus(userId) {
  try {
    const states = await db.loadAllBotStates(userId);
    const stateNames = Object.keys(states);
    const lastSaved = {};
    for (const [type, data] of Object.entries(states)) {
      lastSaved[type] = data._savedAt || null;
    }
    return { states: stateNames, lastSaved };
  } catch (err) {
    return { states: [], lastSaved: {}, error: err.message };
  }
}

module.exports = {
  initModules,
  saveAll,
  loadAll,
  saveOne,
  startAutoSave,
  stopAutoSave,
  getStatus,
};
