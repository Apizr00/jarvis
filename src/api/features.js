// src/api/features.js
// Shared feature registry — used by console startup AND /features command

const FEATURES = [
  { emoji: '🔄', name: 'Conversation Lifecycle', desc: '5-phase: onboarding→idle→active_task→dormant→reactivation' },
  { emoji: '🧠', name: 'State Machine', desc: 'Explicit execution flow with /why trace' },
  { emoji: '📊', name: 'Observability Layer', desc: 'Execution spans, prompt/tool/memory logs, latency tracking' },
  { emoji: '🔒', name: 'Fact Lock System', desc: '3-tier: verified / inferred / uncertain' },
  { emoji: '💾', name: 'Memory Write Strategy', desc: 'Importance scoring, decay, conflict resolution, compression' },
  { emoji: '💰', name: 'LLM Cost Optimizer', desc: 'Token estimation, cost prediction, latency-aware routing' },
  { emoji: '📈', name: 'Proactive Opportunity Scoring', desc: '4D engine: user state + timing + behavior + goal proximity' },
  { emoji: '⚖️', name: 'Tool Arbitration', desc: 'Conflict detection, priority ranking, fallback chaining' },
  { emoji: '🛡️', name: 'Anti-Hallucination', desc: 'Multi-layer validator: actions, times, reminders, facts' },
  { emoji: '🔍', name: 'Pattern Recognition', desc: 'Non-LLM: usage, topics, behavior, trends (zero API cost)' },
  { emoji: '👥', name: 'Relationship Memory', desc: 'Auto-extracts names, relationships, context' },
  { emoji: '🎤', name: 'Voice Messages', desc: 'Transcribed via OpenAI Whisper' },
  { emoji: '🌐', name: 'Web Search', desc: 'Real-time info summarized in BM/EN/Rojak' },
  { emoji: '📋', name: 'Planning Layer', desc: 'Goals → steps with dependencies + progress tracking' },
  { emoji: '💬', name: 'Proactive Chat', desc: 'Bot initiates based on opportunity scores' },
  { emoji: '🧘', name: 'Daily Reflection', desc: 'LLM end-of-day summary with patterns & suggestions' },
  { emoji: '🧪', name: '360+ Test Assertions', desc: 'Scenario-driven user journey + max capability validation' },
];

/**
 * Format features as a compact one-liner list for console output.
 * Each line: "  🔄 Conversation Lifecycle"
 */
function formatFeaturesCompact() {
  return FEATURES.map(f => `  ${f.emoji} ${f.name}`).join('\n');
}

/**
 * Format features as a Markdown message for Telegram.
 * Each line: "🔄 **Conversation Lifecycle** — 5-phase lifecycle..."
 */
function formatFeaturesMarkdown() {
  const header = '*🧩 Jarvis Capabilities*  (' + FEATURES.length + ' modules)\n\n';
  const lines = FEATURES.map(f => f.emoji + ' *' + f.name + '* — ' + f.desc);
  return header + lines.join('\n');
}

module.exports = { FEATURES, formatFeaturesCompact, formatFeaturesMarkdown };
