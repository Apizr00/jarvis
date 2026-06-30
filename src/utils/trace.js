// src/utils/trace.js
// ── Observability Layer (OpenTelemetry-lite) ────────────────────────────────
//
// Lightweight execution tracing for debugging and production observability.
// Tracks every phase of the executive pipeline with timing, metadata, and logs.
//
// Usage:
//   const trace = require('./utils/trace');
//   const span = trace.startSpan('intent_detection', { userId, messageId });
//   // ... do work ...
//   span.end({ tier: 'deep', category: 'task_planning' });
//   trace.logPrompt('system', promptText);
//   trace.logToolCall('create_reminder', args, result);
//
// Integrates with state-machine.js for full execution tracing.

// ── In-memory stores ────────────────────────────────────────────────────────
const spanStore = new Map();       // traceId → Span[]
const promptLogs = new Map();      // traceId → prompt entries[]
const toolCallLogs = new Map();    // traceId → tool call entries[]
const memoryAccessLogs = new Map();// traceId → memory access entries[]
const latencyLogs = new Map();     // userId → [{phase, ms, timestamp}]

const MAX_LOGS_PER_TRACE = 50;
const MAX_LATENCY_ENTRIES = 200;

// ── Active spans ────────────────────────────────────────────────────────────
let _currentTraceId = null;

/**
 * Span — represents a single timed operation within a trace.
 */
class Span {
  constructor(name, meta = {}, traceId) {
    this.name = name;
    this.traceId = traceId || _currentTraceId || 'orphan';
    this.startedAt = Date.now();
    this.endedAt = null;
    this.durationMs = null;
    this.meta = meta;
    this.status = 'running';
  }

  end(extraMeta = {}) {
    this.endedAt = Date.now();
    this.durationMs = this.endedAt - this.startedAt;
    this.status = 'ok';
    Object.assign(this.meta, extraMeta);

    // Store in span store
    if (!spanStore.has(this.traceId)) {
      spanStore.set(this.traceId, []);
    }
    const spans = spanStore.get(this.traceId);
    spans.push(this);
    if (spans.length > MAX_LOGS_PER_TRACE) spans.shift();

    // Track latency per phase
    if (this.meta.userId) {
      if (!latencyLogs.has(this.meta.userId)) {
        latencyLogs.set(this.meta.userId, []);
      }
      const latencies = latencyLogs.get(this.meta.userId);
      latencies.push({
        phase: this.name,
        ms: this.durationMs,
        timestamp: new Date().toISOString(),
      });
      if (latencies.length > MAX_LATENCY_ENTRIES) latencies.shift();
    }

    return this;
  }

  error(err) {
    this.endedAt = Date.now();
    this.durationMs = this.endedAt - this.startedAt;
    this.status = 'error';
    this.meta.error = err.message;
    return this;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Set the current trace ID for this execution context.
 * Called at the start of each message processing.
 */
function setTraceId(traceId) {
  _currentTraceId = traceId;
}

/**
 * Get the current trace ID.
 */
function getTraceId() {
  return _currentTraceId;
}

/**
 * Start a new span for a named operation.
 * @param {string} name - e.g., 'intent_detection', 'memory_load', 'tool_execution'
 * @param {object} [meta={}] - additional metadata
 * @returns {Span}
 */
function startSpan(name, meta = {}) {
  return new Span(name, meta);
}

/**
 * Log a prompt sent to an LLM.
 * @param {'system'|'user'} role
 * @param {string} content - the prompt text
 * @param {string} [provider] - 'deepseek' or 'mimo'
 */
function logPrompt(role, content, provider) {
  const traceId = _currentTraceId || 'unknown';
  if (!promptLogs.has(traceId)) {
    promptLogs.set(traceId, []);
  }
  const logs = promptLogs.get(traceId);
  logs.push({
    role,
    provider: provider || 'unknown',
    contentPreview: typeof content === 'string' ? content.slice(0, 300) : '[non-string]',
    contentLength: typeof content === 'string' ? content.length : 0,
    timestamp: new Date().toISOString(),
  });
  if (logs.length > MAX_LOGS_PER_TRACE) logs.shift();
}

/**
 * Log a tool call execution.
 * @param {string} toolName
 * @param {object} args
 * @param {object} result
 * @param {number} durationMs
 */
function logToolCall(toolName, args, result, durationMs) {
  const traceId = _currentTraceId || 'unknown';
  if (!toolCallLogs.has(traceId)) {
    toolCallLogs.set(traceId, []);
  }
  const logs = toolCallLogs.get(traceId);
  logs.push({
    toolName,
    args: JSON.stringify(args).slice(0, 200),
    resultPreview: typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200),
    success: result && !result.error,
    durationMs: durationMs || 0,
    timestamp: new Date().toISOString(),
  });
  if (logs.length > MAX_LOGS_PER_TRACE) logs.shift();
}

/**
 * Log a memory access (fact retrieval).
 * @param {string} userId
 * @param {Array<string>} factKeys - keys of facts accessed
 * @param {number} count - number of facts returned
 */
function logMemoryAccess(userId, factKeys, count) {
  const traceId = _currentTraceId || 'unknown';
  if (!memoryAccessLogs.has(traceId)) {
    memoryAccessLogs.set(traceId, []);
  }
  const logs = memoryAccessLogs.get(traceId);
  logs.push({
    userId,
    factKeys: factKeys.slice(0, 10),
    count,
    timestamp: new Date().toISOString(),
  });
  if (logs.length > MAX_LOGS_PER_TRACE) logs.shift();
}

// ── Retrieval / Reporting ───────────────────────────────────────────────────

/**
 * Get all spans for a trace.
 */
function getSpans(traceId) {
  return spanStore.get(traceId) || [];
}

/**
 * Get prompt logs for a trace.
 */
function getPromptLogs(traceId) {
  return promptLogs.get(traceId) || [];
}

/**
 * Get tool call logs for a trace.
 */
function getToolCallLogs(traceId) {
  return toolCallLogs.get(traceId) || [];
}

/**
 * Get memory access logs for a trace.
 */
function getMemoryAccessLogs(traceId) {
  return memoryAccessLogs.get(traceId) || [];
}

/**
 * Get average latency per phase for a user.
 * @param {string} userId
 * @returns {object} phase → {avgMs, count, p95Ms}
 */
function getLatencyStats(userId) {
  const entries = latencyLogs.get(userId) || [];
  if (entries.length === 0) return {};

  const byPhase = {};
  for (const e of entries) {
    if (!byPhase[e.phase]) byPhase[e.phase] = [];
    byPhase[e.phase].push(e.ms);
  }

  const stats = {};
  for (const [phase, times] of Object.entries(byPhase)) {
    times.sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    const p95Idx = Math.ceil(times.length * 0.95) - 1;
    stats[phase] = {
      avgMs: Math.round(sum / times.length),
      count: times.length,
      p95Ms: times[p95Idx] || times[times.length - 1],
      minMs: times[0],
      maxMs: times[times.length - 1],
    };
  }
  return stats;
}

/**
 * Get a full trace report combining all observability data.
 * @param {string} traceId
 * @returns {object}
 */
function getFullTraceReport(traceId) {
  return {
    traceId,
    spans: getSpans(traceId).map(s => ({
      name: s.name,
      durationMs: s.durationMs,
      status: s.status,
      meta: s.meta,
    })),
    prompts: getPromptLogs(traceId),
    toolCalls: getToolCallLogs(traceId),
    memoryAccess: getMemoryAccessLogs(traceId),
  };
}

/**
 * Clean up logs for a trace (call after trace expires).
 */
function cleanupTrace(traceId) {
  spanStore.delete(traceId);
  promptLogs.delete(traceId);
  toolCallLogs.delete(traceId);
  memoryAccessLogs.delete(traceId);
}

/**
 * Clean up all logs older than TTL.
 * @param {number} ttlMs - time-to-live in milliseconds
 */
function cleanupOld(ttlMs = 24 * 60 * 60_000) {
  const cutoff = Date.now() - ttlMs;

  for (const [traceId, spans] of spanStore) {
    const allOld = spans.every(s => s.startedAt < cutoff);
    if (allOld) cleanupTrace(traceId);
  }

  for (const [userId, entries] of latencyLogs) {
    const filtered = entries.filter(e => new Date(e.timestamp).getTime() > cutoff);
    if (filtered.length === 0) {
      latencyLogs.delete(userId);
    } else {
      latencyLogs.set(userId, filtered);
    }
  }
}

module.exports = {
  Span,
  setTraceId,
  getTraceId,
  startSpan,
  logPrompt,
  logToolCall,
  logMemoryAccess,
  getSpans,
  getPromptLogs,
  getToolCallLogs,
  getMemoryAccessLogs,
  getLatencyStats,
  getFullTraceReport,
  cleanupTrace,
  cleanupOld,
};
