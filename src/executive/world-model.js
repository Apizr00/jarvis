// src/executive/world-model.js
// ── Enhanced World Model (Fasa 2) ─────────────────────────────────────────
// Tracks the user's current state with domain awareness.
// Richer than basic key-value — understands time patterns, active domains,
// and can predict user's likely state based on time of day.
//
// Model tracks:
//   - Status (working, busy, free, sleeping, exercising, commuting)
//   - Active domains (work, personal, health, learning)
//   - Time-based routines (morning person, night owl, etc.)
//   - Energy patterns (peak hours, low energy times)
//   - Current focus (project, task, interest)

const store = new Map();

/**
 * Get the current hour (0-23) in the configured timezone.
 * Uses Intl.DateTimeFormat for reliable timezone-aware hour extraction.
 */
function getCurrentHour() {
  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();
  return parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
}

const WORLD_MODEL_DEFAULTS = {
  // Basic status
  status: 'unknown',
  statusConfidence: 0,
  statusLastUpdated: null,

  // Active domains (what area of life is active right now)
  activeDomain: 'general',      // work, personal, health, learning, social, finance
  domainConfidence: 0.5,

  // Current project / focus
  currentProject: '',
  currentTask: '',
  focusLevel: 'medium',         // low, medium, high

  // Interests
  interests: [],
  recentTopics: [],

  // Time patterns
  typicalWakeTime: '',
  typicalSleepTime: '',
  peakProductivityHours: [],    // e.g., [9, 10, 11, 15, 16]
  lowEnergyHours: [],           // e.g., [14, 22, 23]

  // Language preference
  preferredLanguage: 'rojak',   // bm, en, rojak

  // Budget / finance
  budgetConcern: '',            // tight, moderate, comfortable
  recentPurchases: [],

  // Health
  lastExercise: null,
  exerciseRoutine: '',

  // Mood tracking
  currentMood: 'neutral',
  moodHistory: [],              // last 5 moods

  // Meta
  messageCount: 0,
  sessionStart: null,
  lastActive: null,
  totalSessions: 0,
};

/**
 * Get world model for a user.
 */
function get(userId) {
  if (!store.has(userId)) {
    const now = new Date().toISOString();
    store.set(userId, { ...WORLD_MODEL_DEFAULTS, sessionStart: now, lastActive: now });
  }
  return store.get(userId);
}

/**
 * Update world model with new information.
 * Automatically derives additional insights from raw updates.
 */
function update(userId, updates = {}) {
  const wm = get(userId);

  // Apply raw updates
  Object.assign(wm, updates);

  // Auto-derive domain if not explicitly set
  if (!updates.activeDomain && updates.lastTopic) {
    wm.activeDomain = deriveDomain(updates.lastTopic, wm);
  }

  // Update mood history
  if (updates.lastMood && updates.lastMood !== 'neutral') {
    wm.currentMood = updates.lastMood;
    wm.moodHistory.push(updates.lastMood);
    if (wm.moodHistory.length > 5) wm.moodHistory.shift();
  }

  // Track session
  if (!wm.sessionStart) {
    wm.sessionStart = new Date().toISOString();
    wm.totalSessions++;
  }

  // Check session expiry (30 min inactivity = new session)
  if (wm.lastActive) {
    const lastActive = new Date(wm.lastActive);
    if (Date.now() - lastActive.getTime() > 30 * 60 * 1000) {
      wm.sessionStart = new Date().toISOString();
      wm.totalSessions++;
    }
  }

  wm.messageCount++;
  wm.lastActive = new Date().toISOString();

  // Derive status from time of day if not explicitly set
  if (!updates.status || updates.status === 'unknown') {
    wm.status = deriveStatusFromTime(wm);
  }

  // Derive energy pattern
  if (!updates.peakProductivityHours && wm.messageCount > 20) {
    wm.peakProductivityHours = guessProductivityHours(wm);
  }

  return wm;
}

/**
 * Derive which domain the user is in based on topic keywords.
 */
function deriveDomain(topic, wm) {
  const lower = topic.toLowerCase();

  const domainKeywords = {
    work: ['kerja', 'work', 'office', 'pejabat', 'meeting', 'mesyuarat', 'client', 'klien',
      'project', 'projek', 'deadline', 'boss', 'colleague', 'kolega', 'task', 'tugasan',
      'code', 'coding', 'programming', 'bug', 'deploy', 'server', 'api'],
    personal: ['family', 'keluarga', 'wife', 'isteri', 'husband', 'suami', 'anak', 'child',
      'rumah', 'house', 'kereta', 'car', 'makan', 'eat', 'food', 'movie', 'filem',
      'netflix', 'game', 'hobby', 'hobi', 'weekend', 'cuti', 'holiday', 'vacation'],
    health: ['gym', 'exercise', 'senaman', 'run', 'lari', 'jogging', 'diet', 'makanan',
      'healthy', 'sihat', 'doctor', 'doktor', 'hospital', 'sleep', 'tidur',
      'yoga', 'meditation', 'meditasi', 'weight', 'berat'],
    learning: ['learn', 'belajar', 'study', 'course', 'kursus', 'book', 'buku', 'read',
      'baca', 'tutorial', 'class', 'kelas', 'exam', 'peperiksaan', 'university',
      'ilmu', 'knowledge', 'skill', 'kemahiran', 'research', 'kaji'],
    social: ['friend', 'kawan', 'meet', 'jumpa', 'party', 'gathering', 'hangout',
      'social', 'sosial', 'chat', 'borak', 'whatsapp', 'call', 'telefon'],
    finance: ['money', 'duit', 'ringgit', 'rm', 'bank', 'saving', 'simpan', 'invest',
      'labur', 'saham', 'stock', 'crypto', 'bitcoin', 'budget', 'bajet',
      'bill', 'bil', 'payment', 'bayar', 'insurance', 'insurans', 'loan'],
  };

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (keywords.some(k => lower.includes(k))) {
      return domain;
    }
  }

  return wm.activeDomain || 'general';
}

/**
 * Guess user's status based on time of day.
 */
function deriveStatusFromTime(wm) {
  const hour = getCurrentHour();

  // Use known sleep/wake times if available
  if (wm.typicalSleepTime && wm.typicalWakeTime) {
    const sleepHour = parseInt(wm.typicalSleepTime) || 23;
    const wakeHour = parseInt(wm.typicalWakeTime) || 7;

    if (hour >= sleepHour || hour < wakeHour) return 'sleeping';
    if (hour >= wakeHour && hour < wakeHour + 2) return 'waking_up';
    if (hour >= 9 && hour < 12) return 'working';
    if (hour >= 12 && hour < 14) return 'lunch_break';
    if (hour >= 14 && hour < 17) return 'working';
    if (hour >= 17 && hour < 19) return 'commuting';
    if (hour >= 19 && hour < 22) return 'free';
    return 'winding_down';
  }

  // Default time-based guesses
  if (hour >= 23 || hour < 5) return 'sleeping';
  if (hour >= 5 && hour < 7) return 'waking_up';
  if (hour >= 7 && hour < 9) return 'commuting';
  if (hour >= 9 && hour < 12) return 'working';
  if (hour >= 12 && hour < 14) return 'lunch_break';
  if (hour >= 14 && hour < 17) return 'working';
  if (hour >= 17 && hour < 19) return 'commuting';
  if (hour >= 19 && hour < 22) return 'free';
  return 'winding_down';
}

/**
 * Guess user's peak productivity hours from message patterns.
 */
function guessProductivityHours(wm) {
  // Simple heuristic: if user is active during 9-11 AM and 3-5 PM, those are peak work hours
  const peakHours = [];
  const hour = getCurrentHour();

  if (hour >= 9 && hour <= 11) peakHours.push(hour);
  if (hour >= 15 && hour <= 17) peakHours.push(hour);

  return peakHours;
}

/**
 * Format world model for LLM prompt injection.
 */
function formatForPrompt(userId) {
  const wm = get(userId);
  const parts = [];

  if (wm.status && wm.status !== 'unknown') {
    const statusLabels = {
      working: '🔵 Working', busy: '🟠 Busy', free: '🟢 Free',
      sleeping: '🌙 Sleeping', commuting: '🚗 Commuting',
      lunch_break: '🍽️ Lunch', winding_down: '🌅 Winding down',
      waking_up: '🌄 Waking up', exercising: '🏃 Exercising',
    };
    parts.push('Status: ' + (statusLabels[wm.status] || wm.status));
  }

  if (wm.activeDomain && wm.activeDomain !== 'general') {
    parts.push('Domain: ' + wm.activeDomain);
  }

  if (wm.currentProject) parts.push('Project: ' + wm.currentProject);
  if (wm.currentTask) parts.push('Current task: ' + wm.currentTask);

  if (wm.currentMood && wm.currentMood !== 'neutral') {
    parts.push('Mood: ' + wm.currentMood);
  }

  if (wm.interests.length > 0) {
    parts.push('Interests: ' + wm.interests.slice(0, 3).join(', '));
  }

  if (wm.preferredLanguage && wm.preferredLanguage !== 'rojak') {
    parts.push('Language: ' + wm.preferredLanguage);
  }

  if (wm.budgetConcern) {
    parts.push('Budget: ' + wm.budgetConcern);
  }

  if (wm.recentTopics.length > 0) {
    parts.push('Recent: ' + wm.recentTopics.slice(0, 3).join(' | '));
  }

  return parts.length > 0 ? 'USER STATE ────────────────────────\n' + parts.join('\n') : '';
}

/**
 * Get a summary of world model insights for proactive suggestions.
 */
function getInsights(userId) {
  const wm = get(userId);
  const insights = [];

  // Time-based insights
  const hour = getCurrentHour();
  if (wm.status === 'sleeping') {
    insights.push('User likely sleeping — avoid notifications');
  } else if (wm.status === 'working' && wm.activeDomain === 'work') {
    insights.push('User is in work mode — productivity suggestions welcome');
  } else if (wm.status === 'free') {
    insights.push('User is free — good time for casual chat or suggestions');
  }

  // Mood insights
  if (wm.moodHistory.filter(m => m === 'tired').length >= 3) {
    insights.push('User has been tired lately — suggest rest/breaks');
  }
  if (wm.moodHistory.filter(m => m === 'motivated').length >= 2) {
    insights.push('User is motivated — suggest tackling goals');
  }

  // Domain insights
  if (wm.activeDomain === 'health' && !wm.lastExercise) {
    insights.push('Health domain active but no exercise logged');
  }

  return insights;
}

module.exports = { get, update, formatForPrompt, getInsights, deriveDomain, deriveStatusFromTime };
