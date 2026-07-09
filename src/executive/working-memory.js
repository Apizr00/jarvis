// src/executive/working-memory.js
// ── Working Memory (Brain Scratchpad) ────────────────────────────────────────
//
// Working memory is NOT chat history. It's the AI's "current thinking" —
// what problem is being solved, what ideas are on the table, what was rejected.
//
// Analogy: If long-term memory is a library, working memory is the desk you're
// working at right now. Small, focused, volatile.
//
// Structure per user:
//   {
//     currentGoal:     string,   // what the user is trying to achieve
//     currentProblem:  string,   // the obstacle or question right now
//     possibleSolutions: [],     // ideas being considered
//     rejectedIdeas:   [],       // ideas that didn't work (avoid repeating)
//     nextSteps:       [],       // what to do next
//     contextNotes:    string,   // quick notes about current context
//     recentTopics:    [],       // topics discussed in last few exchanges (max 10)
//     lastExchangeSummary: string, // one-line summary of the last meaningful exchange
//     conversationFlow: string,  // track conversation direction (e.g., 'planning_trip', 'debugging_code')
//     lastUpdated:     Date,
//     messageCount:    number,   // messages since last reset
//   }

const store = new Map();

const MAX_SOLUTIONS = 5;
const MAX_REJECTED = 10;
const MAX_NEXT_STEPS = 5;
const MAX_RECENT_TOPICS = 10;
const EXPIRE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours inactivity → reset (was 30min — too aggressive)
const RESET_AFTER_MESSAGES = 50;            // reset after 50 messages

/**
 * Get working memory for a user. Creates empty if not exists.
 */
function get(userId) {
  if (!store.has(userId)) {
    store.set(userId, {
      currentGoal: '',
      currentProblem: '',
      possibleSolutions: [],
      rejectedIdeas: [],
      nextSteps: [],
      contextNotes: '',
      recentTopics: [],
      lastExchangeSummary: '',
      conversationFlow: '',
      lastUpdated: new Date(),
      messageCount: 0,
    });
  }

  const wm = store.get(userId);

  // Check expiry
  if (Date.now() - wm.lastUpdated.getTime() > EXPIRE_AFTER_MS) {
    reset(userId);
    return store.get(userId);
  }

  // Check message count reset
  if (wm.messageCount >= RESET_AFTER_MESSAGES) {
    reset(userId);
    return store.get(userId);
  }

  return wm;
}

/**
 * Reset working memory for a user.
 */
function reset(userId) {
  store.set(userId, {
    currentGoal: '',
    currentProblem: '',
    possibleSolutions: [],
    rejectedIdeas: [],
    nextSteps: [],
    contextNotes: '',
    recentTopics: [],
    lastExchangeSummary: '',
    conversationFlow: '',
    lastUpdated: new Date(),
    messageCount: 0,
  });
}

/**
 * Update working memory fields. Only provided fields are changed.
 */
function update(userId, updates = {}) {
  const wm = get(userId);

  if (updates.currentGoal !== undefined) wm.currentGoal = updates.currentGoal;
  if (updates.currentProblem !== undefined) wm.currentProblem = updates.currentProblem;
  if (updates.contextNotes !== undefined) wm.contextNotes = updates.contextNotes;
  if (updates.lastExchangeSummary !== undefined) wm.lastExchangeSummary = updates.lastExchangeSummary;
  if (updates.conversationFlow !== undefined) wm.conversationFlow = updates.conversationFlow;

  if (updates.addSolution && !wm.possibleSolutions.includes(updates.addSolution)) {
    wm.possibleSolutions.unshift(updates.addSolution);
    if (wm.possibleSolutions.length > MAX_SOLUTIONS) wm.possibleSolutions.pop();
  }

  if (updates.rejectSolution) {
    const idx = wm.possibleSolutions.indexOf(updates.rejectSolution);
    if (idx !== -1) {
      wm.possibleSolutions.splice(idx, 1);
      wm.rejectedIdeas.unshift(updates.rejectSolution);
      if (wm.rejectedIdeas.length > MAX_REJECTED) wm.rejectedIdeas.pop();
    }
  }

  if (updates.addNextStep && !wm.nextSteps.includes(updates.addNextStep)) {
    wm.nextSteps.push(updates.addNextStep);
    if (wm.nextSteps.length > MAX_NEXT_STEPS) wm.nextSteps.shift();
  }

  if (updates.completeNextStep !== undefined) {
    wm.nextSteps = wm.nextSteps.filter(s => s !== updates.completeNextStep);
  }

  // Track recent topics — deduplicated, time-ordered
  if (updates.addTopic && !wm.recentTopics.includes(updates.addTopic)) {
    wm.recentTopics.unshift(updates.addTopic);
    if (wm.recentTopics.length > MAX_RECENT_TOPICS) wm.recentTopics.pop();
  }

  wm.lastUpdated = new Date();
  wm.messageCount++;
}

/**
 * Mark that a message was processed (increments counter, updates timestamp).
 */
function touch(userId) {
  const wm = get(userId);
  wm.lastUpdated = new Date();
  wm.messageCount++;
}

/**
 * Format working memory as a compact string for system prompt injection.
 * Returns empty string if nothing meaningful is being tracked.
 */
function formatForPrompt(userId) {
  const wm = get(userId);

  const parts = [];

  // Conversation continuity — MOST IMPORTANT for memory
  if (wm.lastExchangeSummary) parts.push('🔄 Last Exchange: ' + wm.lastExchangeSummary);
  if (wm.conversationFlow) parts.push('🌊 Conversation Flow: ' + wm.conversationFlow);
  if (wm.recentTopics.length > 0) parts.push('📌 Recent Topics: ' + wm.recentTopics.slice(0, 5).join(' → '));

  if (wm.currentGoal) parts.push('🎯 Current Goal: ' + wm.currentGoal);
  if (wm.currentProblem) parts.push('❓ Current Problem: ' + wm.currentProblem);
  if (wm.contextNotes) parts.push('📝 Context: ' + wm.contextNotes);

  if (wm.possibleSolutions.length > 0) {
    parts.push('💡 Possible Solutions: ' + wm.possibleSolutions.slice(0, 3).join(', '));
  }
  if (wm.nextSteps.length > 0) {
    parts.push('➡️ Next Steps: ' + wm.nextSteps.join(', '));
  }
  if (wm.rejectedIdeas.length > 0) {
    parts.push('🚫 Rejected: ' + wm.rejectedIdeas.slice(0, 3).join(', '));
  }

  return parts.length > 0 ? 'WORKING MEMORY ────────────────────\n' + parts.join('\n') : '';
}

/**
 * Check if working memory has active context (user is mid-task).
 */
function isActive(userId) {
  const wm = get(userId);
  return !!(wm.currentGoal || wm.currentProblem || wm.nextSteps.length > 0);
}

module.exports = {
  get, update, reset, touch, formatForPrompt, isActive,
  // Persistence
  serialize,
  hydrate,
};

/**
 * Serialize working memory for DB persistence.
 * @param {string} userId
 * @returns {object|null} serializable data or null if empty/nothing meaningful
 */
function serialize(userId) {
  const raw = store.get(userId);
  if (!raw) return null;

  // Only persist if there's meaningful content
  const hasContent = raw.currentGoal || raw.currentProblem ||
    raw.possibleSolutions.length > 0 || raw.nextSteps.length > 0 ||
    raw.contextNotes || raw.recentTopics.length > 0 ||
    raw.lastExchangeSummary || raw.conversationFlow;

  if (!hasContent && raw.messageCount < 3) return null;

  return {
    currentGoal: raw.currentGoal,
    currentProblem: raw.currentProblem,
    possibleSolutions: raw.possibleSolutions,
    rejectedIdeas: raw.rejectedIdeas,
    nextSteps: raw.nextSteps,
    contextNotes: raw.contextNotes,
    recentTopics: raw.recentTopics || [],
    lastExchangeSummary: raw.lastExchangeSummary || '',
    conversationFlow: raw.conversationFlow || '',
    lastUpdated: raw.lastUpdated instanceof Date ? raw.lastUpdated.toISOString() : raw.lastUpdated,
    messageCount: raw.messageCount,
  };
}

/**
 * Hydrate working memory from persisted DB data.
 * @param {string} userId
 * @param {object} data - previously serialized data
 */
function hydrate(userId, data) {
  if (!data) return;

  store.set(userId, {
    currentGoal: data.currentGoal || '',
    currentProblem: data.currentProblem || '',
    possibleSolutions: data.possibleSolutions || [],
    rejectedIdeas: data.rejectedIdeas || [],
    nextSteps: data.nextSteps || [],
    contextNotes: data.contextNotes || '',
    recentTopics: data.recentTopics || [],
    lastExchangeSummary: data.lastExchangeSummary || '',
    conversationFlow: data.conversationFlow || '',
    lastUpdated: data.lastUpdated ? new Date(data.lastUpdated) : new Date(),
    messageCount: data.messageCount || 0,
  });

  console.log('[WorkingMemory] 💧 Hydrated from DB (msgs: ' + (data.messageCount || 0) + ')');
}
