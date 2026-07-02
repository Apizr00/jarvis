// src/events/index.js
// ── Event Bus ────────────────────────────────────────────────────────────────
//
// A pub/sub event system that decouples components. Instead of direct
// function calls between modules, components emit events that any number
// of listeners can subscribe to. This enables:
//
//   - Loose coupling: modules don't need to know about each other
//   - Extensibility: new features can hook into existing flows
//   - Observability: all system events are traceable in one place
//   - Async isolation: listener failures don't crash the emitter
//
// Architecture:
//
//   ┌──────────┐   emit('message:received')   ┌──────────────┐
//   │   Bot    │ ─────────────────────────────▶│  Event Bus   │
//   └──────────┘                               │              │
//                                              │  ┌────────┐  │
//   ┌──────────┐   emit('tool:executed')       │  │ Router │  │
//   │  Tools   │ ─────────────────────────────▶│  └────────┘  │
//   └──────────┘                               │              │
//                                              │  Listeners:  │
//   ┌──────────┐   on('message:received')      │  - Memory    │
//   │  Memory  │ ◀─────────────────────────────│  - Patterns  │
//   └──────────┘                               │  - Executive │
//                                              │  - Plugins   │
//                                              └──────────────┘
//
// Events follow a namespaced format: domain:action
//
// Core Events:
//   message:received     — user sends a message
//   message:sent         — bot sends a response
//   message:edited       — user edits a message
//   tool:executed        — a tool call completes
//   tool:failed          — a tool call fails
//   reminder:fired       — a scheduled reminder triggers
//   reminder:created     — a new reminder is created
//   intent:detected      — executive classifies intent
//   state:changed        — state machine transitions
//   memory:updated       — a fact is added/updated
//   memory:forgotten     — a fact is removed
//   lifecycle:changed    — conversation phase changes
//   pattern:detected     — a user pattern is found
//   error:occurred       — any system error
//   system:startup       — bot boots up
//   system:shutdown      — bot shuts down
//   plugin:loaded        — a plugin is loaded
//   plugin:unloaded      — a plugin is unloaded
//   agent:task_started   — an agent begins a task
//   agent:task_completed — an agent finishes a task

// ── Event Names (constants for type safety) ─────────────────────────────────

const EVENTS = Object.freeze({
  // Message lifecycle
  MESSAGE_RECEIVED: 'message:received',
  MESSAGE_SENT: 'message:sent',
  MESSAGE_EDITED: 'message:edited',

  // Tool lifecycle
  TOOL_EXECUTED: 'tool:executed',
  TOOL_FAILED: 'tool:failed',

  // Reminders
  REMINDER_FIRED: 'reminder:fired',
  REMINDER_CREATED: 'reminder:created',

  // Executive
  INTENT_DETECTED: 'intent:detected',
  STATE_CHANGED: 'state:changed',

  // Memory
  MEMORY_UPDATED: 'memory:updated',
  MEMORY_FORGOTTEN: 'memory:forgotten',

  // Lifecycle
  LIFECYCLE_CHANGED: 'lifecycle:changed',

  // Patterns
  PATTERN_DETECTED: 'pattern:detected',

  // System
  SYSTEM_STARTUP: 'system:startup',
  SYSTEM_SHUTDOWN: 'system:shutdown',
  ERROR_OCCURRED: 'error:occurred',

  // Plugins
  PLUGIN_LOADED: 'plugin:loaded',
  PLUGIN_UNLOADED: 'plugin:unloaded',

  // Agents
  AGENT_TASK_STARTED: 'agent:task_started',
  AGENT_TASK_COMPLETED: 'agent:task_completed',
});

// ── Middleware ───────────────────────────────────────────────────────────────
//
// Middleware functions run before/after event handlers. They can:
//   - Log events for debugging
//   - Transform or enrich event payloads
//   - Block events based on conditions
//   - Add timing metrics

class MiddlewareChain {
  constructor() {
    this.before = [];
    this.after = [];
  }

  useBefore(fn) { this.before.push(fn); }
  useAfter(fn) { this.after.push(fn); }

  async runBefore(eventName, payload) {
    for (const fn of this.before) {
      try {
        const result = await fn(eventName, payload);
        if (result === false) return false; // block event
        if (result && typeof result === 'object') payload = result; // transform
      } catch (err) {
        console.warn('[EventBus] Before-middleware error:', err.message);
      }
    }
    return payload;
  }

  async runAfter(eventName, payload) {
    for (const fn of this.after) {
      try { await fn(eventName, payload); } catch (err) {
        console.warn('[EventBus] After-middleware error:', err.message);
      }
    }
  }
}

// ── Event Bus ───────────────────────────────────────────────────────────────

class EventBus {
  constructor() {
    /** @type {Map<string, Set<{fn: Function, once: boolean, priority: number}>>} */
    this._listeners = new Map();

    /** @type {Map<string, Array>} */
    this._eventLog = new Map(); // recent events for debugging

    /** @type {MiddlewareChain} */
    this.middleware = new MiddlewareChain();

    /** @type {Set<string>} */
    this._disabledEvents = new Set();

    this._maxLogSize = 500;
    this._started = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the event bus (enables event processing). */
  start() {
    if (this._started) return;
    this._started = true;
    this.emit(EVENTS.SYSTEM_STARTUP, { timestamp: new Date().toISOString() });
    console.log('[EventBus] 🟢 Started');
  }

  /** Stop the event bus (disables event processing). */
  stop() {
    this.emit(EVENTS.SYSTEM_SHUTDOWN, { timestamp: new Date().toISOString() });
    this._started = false;
    console.log('[EventBus] 🔴 Stopped');
  }

  // ── Event Emission ─────────────────────────────────────────────────────

  /**
   * Emit an event to all registered listeners.
   *
   * @param {string} eventName - namespaced event name (e.g., 'message:received')
   * @param {any} payload - data to pass to listeners
   * @param {object} [options]
   * @param {boolean} [options.async=true] - run listeners asynchronously
   * @param {number} [options.timeout=10000] - max ms per listener (async mode)
   * @returns {Promise<Array>} results from all listeners
   */
  async emit(eventName, payload = {}, options = {}) {
    const { async = true, timeout = 10000 } = options;

    if (!this._started && eventName !== EVENTS.SYSTEM_STARTUP) {
      // Buffer events during startup? For now, silently skip.
      return [];
    }

    if (this._disabledEvents.has(eventName)) return [];
    if (this._disabledEvents.has('*')) return [];

    // ── Run before-middleware ──────────────────────────────────────────
    const processedPayload = await this.middleware.runBefore(eventName, { ...payload });
    if (processedPayload === false) return []; // blocked

    // ── Log event ─────────────────────────────────────────────────────
    this._logEvent(eventName, processedPayload);

    // ── Get listeners ─────────────────────────────────────────────────
    const listeners = this._getListeners(eventName);
    if (listeners.length === 0) return [];

    // ── Dispatch to listeners ─────────────────────────────────────────
    const results = [];

    if (async) {
      // Run all listeners concurrently with individual timeouts
      const promises = listeners.map(({ fn, once }) =>
        this._runWithTimeout(fn, processedPayload, timeout)
          .then(result => {
            if (once) this._removeListener(eventName, fn);
            return result;
          })
          .catch(err => {
            console.error('[EventBus] Listener error for "' + eventName + '":', err.message);
            return undefined;
          })
      );
      const settled = await Promise.allSettled(promises);
      for (const s of settled) {
        if (s.status === 'fulfilled') results.push(s.value);
      }
    } else {
      // Run synchronously in priority order
      for (const { fn, once } of listeners) {
        try {
          const result = fn(processedPayload);
          results.push(result);
          if (once) this._removeListener(eventName, fn);
        } catch (err) {
          console.error('[EventBus] Listener error for "' + eventName + '":', err.message);
        }
      }
    }

    // ── Run after-middleware ──────────────────────────────────────────
    await this.middleware.runAfter(eventName, processedPayload);

    return results;
  }

  /**
   * Emit an event synchronously (fire-and-forget, returns void).
   * Use for non-critical notifications where you don't care about results.
   */
  emitSync(eventName, payload = {}) {
    this.emit(eventName, payload, { async: true }).catch(err =>
      console.warn('[EventBus] emitSync error:', err.message)
    );
  }

  // ── Listener Registration ─────────────────────────────────────────────

  /**
   * Register a listener for an event.
   *
   * @param {string} eventName - event to listen for (supports '*' for all events)
   * @param {Function} fn - handler function (receives payload)
   * @param {object} [options]
   * @param {number} [options.priority=0] - higher runs first (within sync mode)
   * @param {boolean} [options.once=false] - auto-remove after first invocation
   * @returns {Function} unsubscribe function
   */
  on(eventName, fn, options = {}) {
    const { priority = 0, once = false } = options;

    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
    }

    const entry = { fn, once, priority };
    this._listeners.get(eventName).add(entry);

    // Return unsubscribe function
    return () => this._removeListener(eventName, fn);
  }

  /**
   * Register a one-time listener.
   */
  once(eventName, fn, options = {}) {
    return this.on(eventName, fn, { ...options, once: true });
  }

  /**
   * Remove a specific listener.
   */
  off(eventName, fn) {
    this._removeListener(eventName, fn);
  }

  /**
   * Remove all listeners for an event (or all events).
   */
  removeAllListeners(eventName) {
    if (eventName) {
      this._listeners.delete(eventName);
    } else {
      this._listeners.clear();
    }
  }

  // ── Event Control ─────────────────────────────────────────────────────

  /**
   * Temporarily disable specific events (or all with '*').
   */
  disableEvents(...eventNames) {
    for (const name of eventNames) {
      this._disabledEvents.add(name);
    }
  }

  /**
   * Re-enable previously disabled events.
   */
  enableEvents(...eventNames) {
    for (const name of eventNames) {
      this._disabledEvents.delete(name);
    }
    this._disabledEvents.delete('*');
  }

  // ── Debug & Observability ─────────────────────────────────────────────

  /**
   * Get recent event history for debugging.
   * @param {string} [eventName] - filter by event name
   * @param {number} [limit=50] - max entries to return
   */
  getEventLog(eventName, limit = 50) {
    if (eventName) {
      return (this._eventLog.get(eventName) || []).slice(-limit);
    }
    // Return all events sorted by timestamp
    const all = [];
    for (const entries of this._eventLog.values()) {
      all.push(...entries);
    }
    all.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return all.slice(-limit);
  }

  /**
   * Get the number of registered listeners.
   */
  get listenerCount() {
    let count = 0;
    for (const set of this._listeners.values()) {
      count += set.size;
    }
    return count;
  }

  /**
   * Get all registered event names.
   */
  get registeredEvents() {
    return Array.from(this._listeners.keys());
  }

  /**
   * Get a snapshot of the event bus state for the status API.
   */
  getStatus() {
    return {
      started: this._started,
      listenerCount: this.listenerCount,
      registeredEvents: this.registeredEvents,
      disabledEvents: Array.from(this._disabledEvents),
      recentEventCount: Array.from(this._eventLog.values()).reduce((sum, arr) => sum + arr.length, 0),
      middlewareActive: this.middleware.before.length > 0 || this.middleware.after.length > 0,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────

  _getListeners(eventName) {
    const listeners = [];
    // Exact match
    if (this._listeners.has(eventName)) {
      listeners.push(...this._listeners.get(eventName));
    }
    // Wildcard listeners (listen to all events)
    if (this._listeners.has('*') && eventName !== EVENTS.SYSTEM_STARTUP) {
      listeners.push(...this._listeners.get('*'));
    }
    // Sort by priority (descending)
    listeners.sort((a, b) => b.priority - a.priority);
    return listeners;
  }

  _removeListener(eventName, fn) {
    const set = this._listeners.get(eventName);
    if (!set) return;
    for (const entry of set) {
      if (entry.fn === fn) {
        set.delete(entry);
        break;
      }
    }
    if (set.size === 0) this._listeners.delete(eventName);
  }

  _logEvent(eventName, payload) {
    if (!this._eventLog.has(eventName)) {
      this._eventLog.set(eventName, []);
    }
    const log = this._eventLog.get(eventName);
    log.push({
      event: eventName,
      timestamp: new Date().toISOString(),
      payloadPreview: this._summarizePayload(payload),
    });
    // Trim to max size
    while (log.length > this._maxLogSize) log.shift();
  }

  _summarizePayload(payload) {
    if (!payload || typeof payload !== 'object') return String(payload).slice(0, 200);
    const summary = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string') {
        summary[k] = v.length > 100 ? v.slice(0, 100) + '...' : v;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        summary[k] = v;
      } else if (v && typeof v === 'object') {
        summary[k] = '[object ' + (v.constructor?.name || 'Object') + ']';
      } else {
        summary[k] = String(v).slice(0, 100);
      }
    }
    return summary;
  }

  _runWithTimeout(fn, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Listener timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);

      try {
        const result = fn(payload);
        if (result && typeof result.then === 'function') {
          result.then(
            val => { clearTimeout(timer); resolve(val); },
            err => { clearTimeout(timer); reject(err); }
          );
        } else {
          clearTimeout(timer);
          resolve(result);
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

const eventBus = new EventBus();

module.exports = { EventBus, eventBus, EVENTS };
