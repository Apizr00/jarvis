// src/executive/state-machine.js
// ── Formal State Machine for Executive Flow ────────────────────────────────
//
// Makes the previously implicit execution phases EXPLICIT and traceable.
// Every state transition is recorded, enabling:
//   - Debug: trace exactly what happened in each phase
//   - Replay: re-emit state transitions to reproduce behavior
//   - Explain: answer "kenapa bot jawab macam ni?" with /why command
//
// States:
//   idle              → waiting for user input
//   intent_detected   → user message classified (tier, category, mood)
//   memory_loaded     → relevant facts, relationships, domains retrieved
//   plan_created      → (deep tier) multi-step plan generated
//   tools_executed    → tool calls completed
//   response_evaluated → response quality scored
//   completed          → final response sent to user
//   error              → something went wrong
//
// Transitions follow the 5-fasa pipeline:
//   idle → intent_detected → memory_loaded → [plan_created] → tools_executed → response_evaluated → completed

const STATES = Object.freeze({
  IDLE: 'idle',
  INTENT_DETECTED: 'intent_detected',
  MEMORY_LOADED: 'memory_loaded',
  PLAN_CREATED: 'plan_created',
  TOOLS_EXECUTED: 'tools_executed',
  RESPONSE_EVALUATED: 'response_evaluated',
  COMPLETED: 'completed',
  ERROR: 'error',
});

const VALID_TRANSITIONS = {
  [STATES.IDLE]: [STATES.INTENT_DETECTED, STATES.ERROR],
  [STATES.INTENT_DETECTED]: [STATES.MEMORY_LOADED, STATES.ERROR],
  [STATES.MEMORY_LOADED]: [STATES.PLAN_CREATED, STATES.TOOLS_EXECUTED, STATES.RESPONSE_EVALUATED, STATES.ERROR],
  [STATES.PLAN_CREATED]: [STATES.TOOLS_EXECUTED, STATES.RESPONSE_EVALUATED, STATES.ERROR],
  [STATES.TOOLS_EXECUTED]: [STATES.RESPONSE_EVALUATED, STATES.ERROR],
  [STATES.RESPONSE_EVALUATED]: [STATES.COMPLETED, STATES.ERROR],
  [STATES.COMPLETED]: [STATES.IDLE],
  [STATES.ERROR]: [STATES.IDLE],
};

const MAX_TRACES_PER_USER = 20;       // keep last 20 execution traces
const TRACE_TTL_MS = 24 * 60 * 60_000; // 24 hours

// ── In-memory trace store (userId → traces[]) ───────────────────────────────
const traceStore = new Map();

// ── Active state machines (userId → StateMachine) ───────────────────────────
const activeMachines = new Map();

/**
 * Represents a single state transition record.
 */
class StateTransition {
  /**
   * @param {string} from - previous state
   * @param {string} to - new state
   * @param {object} [meta={}] - arbitrary metadata about this transition
   */
  constructor(from, to, meta = {}) {
    this.from = from;
    this.to = to;
    this.timestamp = new Date().toISOString();
    this.meta = meta;
  }
}

/**
 * Represents a full execution trace for one user message.
 */
class ExecutionTrace {
  constructor(userId, userMessage, traceId) {
    this.traceId = traceId || 'trace_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    this.userId = userId;
    this.userMessage = userMessage.slice(0, 200); // truncate for storage
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.transitions = [];
    this.finalState = null;
    this.metadata = {}; // arbitrary key-value for cross-phase data
  }

  addTransition(from, to, meta = {}) {
    this.transitions.push(new StateTransition(from, to, meta));
  }

  complete(finalState, meta = {}) {
    this.completedAt = new Date().toISOString();
    this.finalState = finalState;
    if (meta) Object.assign(this.metadata, meta);
  }

  get durationMs() {
    if (!this.completedAt) return null;
    return new Date(this.completedAt) - new Date(this.startedAt);
  }

  get phaseTimings() {
    const timings = {};
    let prevTs = null;
    for (const t of this.transitions) {
      const ts = new Date(t.timestamp).getTime();
      if (prevTs) {
        const phaseName = t.from + '→' + t.to;
        timings[phaseName] = ts - prevTs;
      }
      prevTs = ts;
    }
    return timings;
  }

  toJSON() {
    return {
      traceId: this.traceId,
      userId: this.userId,
      userMessage: this.userMessage,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      durationMs: this.durationMs,
      finalState: this.finalState,
      phaseTimings: this.phaseTimings,
      transitions: this.transitions.map(t => ({
        from: t.from,
        to: t.to,
        timestamp: t.timestamp,
        meta: this._sanitizeMeta(t.meta),
      })),
      metadata: this._sanitizeMeta(this.metadata),
    };
  }

  _sanitizeMeta(meta) {
    // Truncate large fields for storage
    const sanitized = {};
    for (const [k, v] of Object.entries(meta || {})) {
      if (typeof v === 'string' && v.length > 500) {
        sanitized[k] = v.slice(0, 500) + '...';
      } else if (typeof v === 'object' && v !== null) {
        try {
          const str = JSON.stringify(v);
          sanitized[k] = str.length > 500 ? JSON.parse(str.slice(0, 500)) : v;
        } catch {
          sanitized[k] = '[unserializable]';
        }
      } else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  }
}

/**
 * Formal State Machine for a single user interaction.
 * Wraps the executive pipeline to track state transitions.
 */
class StateMachine {
  /**
   * @param {string} userId
   * @param {string} userMessage
   * @param {string} [traceId]
   */
  constructor(userId, userMessage, traceId) {
    this.userId = userId;
    this.userMessage = userMessage;
    this.trace = new ExecutionTrace(userId, userMessage, traceId);
    this._state = STATES.IDLE;
  }

  get state() { return this._state; }
  get traceId() { return this.trace.traceId; }
  get phaseTimings() { return this.trace.phaseTimings; }

  /**
   * Transition to a new state. Validates the transition is allowed.
   * @param {string} to - target state
   * @param {object} [meta={}] - metadata for this transition
   * @returns {boolean} true if transition was valid and applied
   */
  transition(to, meta = {}) {
    const allowed = VALID_TRANSITIONS[this._state] || [];
    if (!allowed.includes(to)) {
      console.warn(
        '[StateMachine] Invalid transition: ' + this._state + ' → ' + to +
        ' (allowed: ' + allowed.join(', ') + ')'
      );
      return false;
    }

    this.trace.addTransition(this._state, to, meta);
    this._state = to;

    // Log transition for observability
    const metaStr = Object.keys(meta).length > 0 ? ' | ' + JSON.stringify(meta).slice(0, 100) : '';
    console.log('[StateMachine] ' + this.traceId + ': ' + this.trace.transitions[this.trace.transitions.length - 1].from + ' → ' + to + metaStr);

    return true;
  }

  /**
   * Mark the trace as complete and store it.
   * @param {string} finalState
   * @param {object} [meta={}]
   */
  finish(finalState, meta = {}) {
    this.trace.complete(finalState, meta);
    this._state = finalState;

    // Store trace
    if (!traceStore.has(this.userId)) {
      traceStore.set(this.userId, []);
    }
    const traces = traceStore.get(this.userId);
    traces.push(this.trace);

    // Prune old traces
    while (traces.length > MAX_TRACES_PER_USER) {
      traces.shift();
    }

    // Schedule expiry
    setTimeout(() => {
      const idx = traces.indexOf(this.trace);
      if (idx !== -1) traces.splice(idx, 1);
    }, TRACE_TTL_MS);

    console.log(
      '[StateMachine] ' + this.traceId + ' finished: ' + finalState +
      ' | duration: ' + (this.trace.durationMs || '?') + 'ms' +
      ' | phases: ' + JSON.stringify(this.trace.phaseTimings)
    );
  }

  /**
   * Transition to error state with error metadata.
   */
  error(err) {
    this.transition(STATES.ERROR, {
      error: err.message,
      stack: err.stack?.slice(0, 300),
    });
    this.finish(STATES.ERROR);
  }

  toJSON() {
    return this.trace.toJSON();
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new state machine for a user interaction.
 * @param {string} userId
 * @param {string} userMessage
 * @returns {StateMachine}
 */
function create(userId, userMessage) {
  const sm = new StateMachine(userId, userMessage);
  activeMachines.set(userId, sm);
  return sm;
}

/**
 * Get the currently active state machine for a user (if any).
 */
function getActive(userId) {
  return activeMachines.get(userId) || null;
}

/**
 * Get recent execution traces for a user.
 * @param {string} userId
 * @param {number} [limit=5] - max number of traces to return
 * @returns {Array<object>}
 */
function getRecentTraces(userId, limit = 5) {
  const traces = traceStore.get(userId) || [];
  return traces.slice(-limit).reverse().map(t => t.toJSON());
}

/**
 * Get the last execution trace for a user.
 */
function getLastTrace(userId) {
  const traces = traceStore.get(userId) || [];
  return traces.length > 0 ? traces[traces.length - 1].toJSON() : null;
}

/**
 * Format traces as a human-readable explanation (for /why command).
 * @param {string} userId
 * @returns {string}
 */
function formatWhy(userId) {
  const traces = traceStore.get(userId) || [];
  if (traces.length === 0) return '🤷 Tiada execution trace tersimpan.';

  const last = traces[traces.length - 1];
  const t = last.toJSON();

  let output = '🧠 **Kenapa bot jawab macam ni?**\n\n';
  output += '`' + t.traceId + '`\n\n';
  output += '**User message:** ' + t.userMessage + '\n';
  output += '**Duration:** ' + (t.durationMs || '?') + 'ms\n\n';

  output += '**Execution phases:**\n';
  for (const tr of t.transitions) {
    const phaseMs = t.phaseTimings[tr.from + '→' + tr.to];
    const timingStr = phaseMs !== undefined ? ' (' + phaseMs + 'ms)' : '';
    output += '  ' + tr.from + ' → **' + tr.to + '**' + timingStr + '\n';

    // Show key metadata for each phase
    if (tr.meta) {
      for (const [k, v] of Object.entries(tr.meta)) {
        const valStr = typeof v === 'string' ? v : JSON.stringify(v);
        if (valStr.length < 80) {
          output += '    • ' + k + ': ' + valStr + '\n';
        }
      }
    }
  }

  output += '\n**Final state:** ' + t.finalState;

  if (t.metadata && Object.keys(t.metadata).length > 0) {
    output += '\n\n**Metadata:**';
    for (const [k, v] of Object.entries(t.metadata)) {
      output += '\n  • ' + k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v));
    }
  }

  return output;
}

/**
 * Clear all traces for a user.
 */
function clearTraces(userId) {
  traceStore.delete(userId);
  activeMachines.delete(userId);
}

module.exports = {
  STATES,
  StateMachine,
  ExecutionTrace,
  create,
  getActive,
  getRecentTraces,
  getLastTrace,
  formatWhy,
  clearTraces,
};
