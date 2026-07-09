// src/db/index.js
// Central database connection pool with retry support
require('dotenv').config();
const { Pool } = require('pg');
const { withRetry } = require('../utils/retry');
const { logger } = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  logger.error('Unexpected DB pool error', { error: err.message, code: err.code });
  console.error('Unexpected DB error:', err.message);
});

// ── Retry-wrapped query helper ──────────────────────────────────────────────
// Gunakan untuk query kritikal yang perlu automatic retry pada transient errors.
// Contoh: await retryQuery('SELECT ...', [param1])
const retryQuery = async (text, params, retryOpts = {}) => {
  return withRetry(
    () => pool.query(text, params),
    {
      maxRetries: retryOpts.maxRetries ?? 2,
      baseDelayMs: 200,
      name: 'DB: ' + (typeof text === 'string' ? text.substring(0, 50).replace(/\n/g, ' ') : 'query'),
      ...retryOpts,
    }
  );
};

// ── Users ─────────────────────────────────────────────────────────────────────

/**
 * Ensure a user row exists. Creates one if missing.
 * @param {string} telegramId
 * @param {string} [name]
 */
async function ensureUser(telegramId, name = 'Owner') {
  await pool.query(
    `INSERT INTO users (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [String(telegramId), name]
  );
}

async function getUserName(telegramId) {
  const { rows } = await pool.query(
    `SELECT name FROM users WHERE id = $1`,
    [String(telegramId)]
  );
  return rows.length > 0 ? rows[0].name : null;
}

// ── Reminders ─────────────────────────────────────────────────────────────────

async function createReminder(userId, text, remindAt, recurrence = null) {
  const { rows } = await pool.query(
    `INSERT INTO reminders (user_id, text, remind_at, recurrence)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [String(userId), text, remindAt, recurrence]
  );
  return rows[0];
}

async function getPendingReminders() {
  const { rows } = await pool.query(
    `SELECT * FROM reminders
     WHERE remind_at <= NOW() AND status = 'pending'
     ORDER BY remind_at ASC`
  );
  return rows;
}

async function markReminderSent(id) {
  await pool.query(
    `UPDATE reminders SET status = 'sent' WHERE id = $1`,
    [id]
  );
}

async function getTodayReminders(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM reminders
     WHERE user_id = $1
       AND DATE(remind_at AT TIME ZONE $2) = CURRENT_DATE AT TIME ZONE $2
       AND status = 'pending'
     ORDER BY remind_at ASC`,
    [String(userId), process.env.TIMEZONE || 'UTC']
  );
  return rows;
}

/**
 * Get all upcoming pending reminders for a user (future + today's unfired).
 */
async function getUpcomingReminders(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM reminders
     WHERE user_id = $1
       AND status = 'pending'
     ORDER BY remind_at ASC
     LIMIT $2`,
    [String(userId), limit]
  );
  return rows;
}

/**
 * Get reminders that are past due (overdue).
 */
async function getOverdueReminders(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM reminders
     WHERE user_id = $1
       AND remind_at < NOW()
       AND status = 'pending'
     ORDER BY remind_at ASC`,
    [String(userId)]
  );
  return rows;
}

/**
 * Cancel a reminder by id (sets status to 'cancelled').
 */
async function cancelReminder(id) {
  await pool.query(
    `UPDATE reminders SET status = 'cancelled' WHERE id = $1`,
    [id]
  );
}

/**
 * Update an existing reminder's text, time, and/or recurrence.
 * @param {number} id
 * @param {{ text?: string, remind_at?: string, recurrence?: string|null }} updates
 * @returns {Promise<object>} the updated row
 */
async function updateReminder(id, updates) {
  const setClauses = [];
  const values = [];
  let paramIdx = 1;

  if (updates.text !== undefined) {
    setClauses.push('text = $' + paramIdx++);
    values.push(updates.text);
  }
  if (updates.remind_at !== undefined) {
    setClauses.push('remind_at = $' + paramIdx++);
    values.push(updates.remind_at);
  }
  if (updates.recurrence !== undefined) {
    setClauses.push('recurrence = $' + paramIdx++);
    values.push(updates.recurrence);
  }

  if (setClauses.length === 0) return null;

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE reminders SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Reschedule a recurring reminder to its next occurrence.
 */
async function rescheduleRecurring(id, recurrence, lastRemindAt) {
  let nextTime;
  const last = new Date(lastRemindAt);

  switch (recurrence) {
    case 'daily':
      nextTime = new Date(last);
      nextTime.setDate(nextTime.getDate() + 1);
      break;
    case 'weekly':
      nextTime = new Date(last);
      nextTime.setDate(nextTime.getDate() + 7);
      break;
    case 'weekdays':
      nextTime = new Date(last);
      // Advance day by day until we hit a weekday
      do {
        nextTime.setDate(nextTime.getDate() + 1);
      } while (nextTime.getDay() === 0 || nextTime.getDay() === 6);
      break;
    default:
      return null; // not recurring
  }

  await pool.query(
    `UPDATE reminders SET remind_at = $1 WHERE id = $2`,
    [nextTime.toISOString(), id]
  );
  return nextTime;
}

// ── Events ────────────────────────────────────────────────────────────────────

async function createEvent(userId, title, eventTime, durationMinutes = 60) {
  const { rows } = await pool.query(
    `INSERT INTO events (user_id, title, event_time, duration_minutes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [String(userId), title, eventTime, durationMinutes]
  );
  return rows[0];
}

async function getTodayEvents(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM events
     WHERE user_id = $1
       AND DATE(event_time AT TIME ZONE $2) = CURRENT_DATE AT TIME ZONE $2
     ORDER BY event_time ASC`,
    [String(userId), process.env.TIMEZONE || 'UTC']
  );
  return rows;
}

/**
 * Cancel an event by deleting it (events don't have a status column).
 */
async function cancelEvent(id) {
  await pool.query(`DELETE FROM events WHERE id = $1`, [id]);
}

/**
 * Update an existing event's title, time, and/or duration.
 */
async function updateEvent(id, updates) {
  const setClauses = [];
  const values = [];
  let paramIdx = 1;

  if (updates.title !== undefined) {
    setClauses.push('title = $' + paramIdx++);
    values.push(updates.title);
  }
  if (updates.event_time !== undefined) {
    setClauses.push('event_time = $' + paramIdx++);
    values.push(updates.event_time);
  }
  if (updates.duration_minutes !== undefined) {
    setClauses.push('duration_minutes = $' + paramIdx++);
    values.push(updates.duration_minutes);
  }

  if (setClauses.length === 0) return null;

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE events SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Snooze a reminder by pushing its remind_at forward by N minutes.
 */
async function snoozeReminder(id, minutes = 10) {
  const { rows } = await pool.query(
    `UPDATE reminders SET remind_at = remind_at + ($2 || ' minutes')::INTERVAL WHERE id = $1 RETURNING *`,
    [id, String(minutes)]
  );
  return rows[0] || null;
}

// ── Notes ─────────────────────────────────────────────────────────────────────

async function addNote(userId, content) {
  const { rows } = await pool.query(
    `INSERT INTO notes (user_id, content) VALUES ($1, $2) RETURNING *`,
    [String(userId), content]
  );
  return rows[0];
}

/**
 * Delete a note by ID.
 */
async function deleteNote(id) {
  await pool.query(`DELETE FROM notes WHERE id = $1`, [id]);
}

async function getRecentNotes(userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM notes WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [String(userId), limit]
  );
  return rows;
}

// ── Memory Facts ──────────────────────────────────────────────────────────────

async function setFact(userId, key, value) {
  const { rows } = await pool.query(
    `INSERT INTO memory_facts (user_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = $3, updated_at = NOW()
     RETURNING *`,
    [String(userId), key, value]
  );
  return rows[0];
}

async function getAllFacts(userId) {
  const { rows } = await pool.query(
    `SELECT key, value, confidence, conflict_flag, importance, access_count, updated_at, last_accessed_at FROM memory_facts WHERE user_id = $1`,
    [String(userId)]
  );
  return rows;
}

/**
 * Delete a memory fact by user and key.
 */
async function deleteFact(userId, key) {
  await pool.query(
    `DELETE FROM memory_facts WHERE user_id = $1 AND key = $2`,
    [String(userId), key]
  );
}

// ── Full memory dump ──────────────────────────────────────────────────────────

async function getFullMemory(userId) {
  const [remindersRes, eventsRes, notesRes, factsRes] = await Promise.all([
    pool.query(`SELECT * FROM reminders WHERE user_id = $1 ORDER BY remind_at DESC LIMIT 20`, [String(userId)]),
    pool.query(`SELECT * FROM events WHERE user_id = $1 ORDER BY event_time DESC LIMIT 20`, [String(userId)]),
    pool.query(`SELECT * FROM notes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [String(userId)]),
    pool.query(`SELECT * FROM memory_facts WHERE user_id = $1`, [String(userId)]),
  ]);
  return {
    reminders: remindersRes.rows,
    events: eventsRes.rows,
    notes: notesRes.rows,
    facts: factsRes.rows,
  };
}

// ── Weekly Review Queries ─────────────────────────────────────────────────────

/**
 * Get notes created since a given date.
 */
async function getNotesSince(userId, since) {
  const { rows } = await pool.query(
    `SELECT * FROM notes
     WHERE user_id = $1 AND created_at >= $2
     ORDER BY created_at DESC`,
    [String(userId), since]
  );
  return rows;
}

/**
 * Get reminders that were due this week (fired or still pending within range).
 * Uses remind_at date as a proxy for "completed this week".
 */
async function getRemindersDueInRange(userId, fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT * FROM reminders
     WHERE user_id = $1
       AND remind_at >= $2 AND remind_at < $3
     ORDER BY remind_at ASC`,
    [String(userId), fromDate, toDate]
  );
  return rows;
}

/**
 * Get upcoming reminders for the next 7 days.
 */
async function getUpcomingRemindersNextWeek(userId, fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT * FROM reminders
     WHERE user_id = $1
       AND remind_at >= $2 AND remind_at < $3
       AND status = 'pending'
     ORDER BY remind_at ASC`,
    [String(userId), fromDate, toDate]
  );
  return rows;
}

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * Get a single setting value for a user. Falls back to env if not in DB.
 * @param {string} userId
 * @param {string} key - setting key (e.g. 'bot_name', 'bot_personality')
 * @returns {Promise<string|null>} the value or null
 */
async function getSetting(userId, key) {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE user_id = $1 AND key = $2`,
    [String(userId), key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * Get all settings for a user as a key-value object.
 * @param {string} userId
 * @returns {Promise<Record<string,string>>}
 */
async function getAllSettings(userId) {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE user_id = $1`,
    [String(userId)]
  );
  const result = {};
  rows.forEach(r => { result[r.key] = r.value; });
  return result;
}

/**
 * Upsert a setting value for a user.
 * @param {string} userId
 * @param {string} key
 * @param {string} value
 * @returns {Promise<object>} the inserted/updated row
 */
async function setSetting(userId, key, value) {
  const { rows } = await pool.query(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = $3, updated_at = NOW()
     RETURNING *`,
    [String(userId), key, value]
  );
  return rows[0];
}

/**
 * Helper: get a config value with DB-first, env-fallback strategy.
 * @param {string} userId
 * @param {string} key - DB settings key
 * @param {string} envKey - process.env key to fallback to
 * @param {string} [defaultVal] - hardcoded fallback if both are null
 * @returns {Promise<string>}
 */
async function getConfig(userId, key, envKey, defaultVal = '') {
  const dbVal = await getSetting(userId, key);
  if (dbVal !== null && dbVal !== '') return dbVal;
  return process.env[envKey] || defaultVal;
}

// ── Chat History ──────────────────────────────────────────────────────────────

/**
 * Save a single chat message to persistent history.
 * @param {string} userId
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @returns {Promise<object>} the inserted row
 */
async function saveChatMessage(userId, role, content) {
  const { rows } = await pool.query(
    `INSERT INTO chat_history (user_id, role, content) VALUES ($1, $2, $3) RETURNING *`,
    [String(userId), role, content]
  );
  return rows[0];
}

/**
 * Get the most recent N chat messages for a user.
 * Used to restore short-term memory after a restart.
 * @param {string} userId
 * @param {number} [limit=20] - max messages to return
 * @returns {Promise<Array<{role:string, content:string}>>}
 */
async function getRecentChatHistory(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT role, content FROM chat_history
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [String(userId), limit]
  );
  // Reverse to chronological order (oldest first)
  return rows.reverse();
}

/**
 * Search chat history for messages matching a query.
 * Used for episodic memory — "what did we talk about last week?"
 * @param {string} userId
 * @param {string} query - search term
 * @param {number} [limit=10]
 * @returns {Promise<Array<{role:string, content:string, created_at:string}>>}
 */
async function searchChatHistory(userId, query, limit = 10) {
  const { rows } = await pool.query(
    `SELECT role, content, created_at FROM chat_history
     WHERE user_id = $1
       AND (content ILIKE '%' || $2 || '%' OR $2 = '')
     ORDER BY created_at DESC
     LIMIT $3`,
    [String(userId), query, limit]
  );
  return rows;
}

/**
 * Get chat messages within a date range (for episodic/weekly review).
 * @param {string} userId
 * @param {string} fromDate - ISO date string
 * @param {string} toDate - ISO date string
 * @returns {Promise<Array<{role:string, content:string, created_at:string}>>}
 */
async function getChatHistoryInRange(userId, fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT role, content, created_at FROM chat_history
     WHERE user_id = $1
       AND created_at >= $2 AND created_at < $3
     ORDER BY created_at ASC`,
    [String(userId), fromDate, toDate]
  );
  return rows;
}

/**
 * Delete old chat history beyond a certain age.
 * Keeps the DB lean — only recent history is useful for short-term context.
 * @param {string} userId
 * @param {number} [keepDays=90] - keep history up to this many days old
 * @returns {Promise<number>} number of rows deleted
 */
async function pruneOldChatHistory(userId, keepDays = 90) {
  const { rowCount } = await pool.query(
    `DELETE FROM chat_history
     WHERE user_id = $1
       AND created_at < NOW() - ($2 || ' days')::INTERVAL`,
    [String(userId), String(keepDays)]
  );
  return rowCount;
}

/**
 * Get a summary of topics discussed (for reflection).
 * Returns a count of messages per day in the last N days.
 * @param {string} userId
 * @param {number} [days=7]
 * @returns {Promise<Array<{date:string, user_count:string, assistant_count:string}>>}
 */
async function getChatActivitySummary(userId, days = 7) {
  const { rows } = await pool.query(
    `SELECT
       DATE(created_at) AS date,
       COUNT(*) FILTER (WHERE role = 'user') AS user_count,
       COUNT(*) FILTER (WHERE role = 'assistant') AS assistant_count
     FROM chat_history
     WHERE user_id = $1
       AND created_at >= NOW() - ($2 || ' days')::INTERVAL
     GROUP BY DATE(created_at)
     ORDER BY date DESC`,
    [String(userId), String(days)]
  );
  return rows;
}

// ── Confidence & Conflict Management ─────────────────────────────────────────

/**
 * Update confidence score for a fact. Used when user confirms/corrects info.
 * @param {string} userId
 * @param {string} key
 * @param {number} confidence - 0.0 to 1.0
 */
async function updateFactConfidence(userId, key, confidence) {
  await pool.query(
    `UPDATE memory_facts SET confidence = $3, updated_at = NOW() WHERE user_id = $1 AND key = $2`,
    [String(userId), key, Math.max(0, Math.min(1, confidence))]
  );
}

/**
 * Mark a fact as having conflicting information (e.g. old value vs new value).
 * Saves the previous value so user can review.
 * @param {string} userId
 * @param {string} key
 * @param {string} previousValue - the old value being replaced
 */
async function flagFactConflict(userId, key, previousValue) {
  await pool.query(
    `UPDATE memory_facts
     SET conflict_flag = TRUE, previous_value = $3, confidence = GREATEST(confidence - 0.2, 0.1), updated_at = NOW()
     WHERE user_id = $1 AND key = $2`,
    [String(userId), key, previousValue]
  );
}

/**
 * Resolve a conflict on a fact (user picked which value is correct).
 * @param {string} userId
 * @param {string} key
 * @param {'keep_current'|'restore_previous'} resolution
 */
async function resolveFactConflict(userId, key, resolution) {
  if (resolution === 'restore_previous') {
    // Swap: restore previous_value → current, keep old current as previous_value
    await pool.query(
      `UPDATE memory_facts
       SET value = previous_value,
           previous_value = value,
           conflict_flag = FALSE,
           confidence = 0.9,
           updated_at = NOW()
       WHERE user_id = $1 AND key = $2 AND previous_value IS NOT NULL`,
      [String(userId), key]
    );
  } else {
    // Keep current, clear conflict
    await pool.query(
      `UPDATE memory_facts
       SET conflict_flag = FALSE, previous_value = NULL, confidence = 0.9, updated_at = NOW()
       WHERE user_id = $1 AND key = $2`,
      [String(userId), key]
    );
  }
}

/**
 * Get all facts that have unresolved conflicts.
 * @param {string} userId
 * @returns {Promise<Array<{key:string, value:string, previous_value:string|null, confidence:number}>>}
 */
async function getConflictFacts(userId) {
  const { rows } = await pool.query(
    `SELECT key, value, previous_value, confidence
     FROM memory_facts WHERE user_id = $1 AND conflict_flag = TRUE`,
    [String(userId)]
  );
  return rows;
}

// ── Reflections ──────────────────────────────────────────────────────────────

/**
 * Save a daily reflection.
 * @param {string} userId
 * @param {string} date - YYYY-MM-DD
 * @param {string} summary - main reflection text
 * @param {string} [patternInsights] - detected patterns
 * @param {string} [factChanges] - facts that changed today
 * @returns {Promise<object>}
 */
async function saveReflection(userId, date, summary, patternInsights, factChanges) {
  const { rows } = await pool.query(
    `INSERT INTO reflections (user_id, date, summary, pattern_insights, fact_changes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, date) DO UPDATE
       SET summary = $3, pattern_insights = $4, fact_changes = $5, created_at = NOW()
     RETURNING *`,
    [String(userId), date, summary, patternInsights || null, factChanges || null]
  );
  return rows[0];
}

/**
 * Get the most recent reflections.
 * @param {string} userId
 * @param {number} [limit=7]
 * @returns {Promise<Array>}
 */
async function getRecentReflections(userId, limit = 7) {
  const { rows } = await pool.query(
    `SELECT * FROM reflections WHERE user_id = $1 ORDER BY date DESC LIMIT $2`,
    [String(userId), limit]
  );
  return rows;
}

/**
 * Get today's reflection if it exists.
 * Uses the configured timezone for consistent "today" calculation.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getTodayReflection(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM reflections
     WHERE user_id = $1
       AND date = (CURRENT_DATE AT TIME ZONE $2)::date`,
    [String(userId), process.env.TIMEZONE || 'UTC']
  );
  return rows.length > 0 ? rows[0] : null;
}

// ── Tasks & Goals ────────────────────────────────────────────────────────────

async function createGoal(userId, title, description = '', targetDate = null) {
  const { rows } = await pool.query(
    `INSERT INTO goals (user_id, title, description, target_date)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [String(userId), title, description, targetDate]
  );
  return rows[0];
}
async function updateGoal(id, updates) {
  const setClauses = []; const values = []; let p = 1;
  for (const [col, val] of Object.entries(updates)) {
    if (val !== undefined) { setClauses.push(col + ' = $' + p++); values.push(val); }
  }
  if (setClauses.length === 0) return null;
  setClauses.push('updated_at = NOW()'); values.push(id);
  const { rows } = await pool.query(`UPDATE goals SET ${setClauses.join(', ')} WHERE id = $${p} RETURNING *`, values);
  return rows[0] || null;
}
async function completeGoal(id) {
  const { rows } = await pool.query(`UPDATE goals SET status = 'completed', progress = 100, updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}
async function abandonGoal(id) {
  const { rows } = await pool.query(`UPDATE goals SET status = 'abandoned', updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}
async function getActiveGoals(userId) {
  const { rows } = await pool.query(`SELECT * FROM goals WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC`, [String(userId)]);
  return rows;
}
async function getAllGoals(userId) {
  const { rows } = await pool.query(`SELECT * FROM goals WHERE user_id = $1 ORDER BY status, created_at DESC`, [String(userId)]);
  return rows;
}

async function createTask(userId, title, description = '', priority = 'medium', dueDate = null, goalId = null) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (user_id, title, description, priority, due_date, goal_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [String(userId), title, description, priority, dueDate, goalId]
  );
  return rows[0];
}
async function startTask(id) {
  const { rows } = await pool.query(`UPDATE tasks SET status = 'in_progress', updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}
async function completeTask(id) {
  const { rows } = await pool.query(`UPDATE tasks SET status = 'done', updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}
async function cancelTask(id) {
  const { rows } = await pool.query(`UPDATE tasks SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}
async function updateTask(id, updates) {
  const setClauses = []; const values = []; let p = 1;
  for (const [col, val] of Object.entries(updates)) {
    if (val !== undefined) { setClauses.push(col + ' = $' + p++); values.push(val); }
  }
  if (setClauses.length === 0) return null;
  setClauses.push('updated_at = NOW()'); values.push(id);
  const { rows } = await pool.query(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $${p} RETURNING *`, values);
  return rows[0] || null;
}
async function getTasksByStatus(userId, status) {
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE user_id = $1 AND status = $2 ORDER BY priority DESC, due_date ASC NULLS LAST`, [String(userId), status]);
  return rows;
}
async function getActiveTasks(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE user_id = $1 AND status IN ('pending', 'in_progress')
     ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, due_date ASC NULLS LAST`, [String(userId)]);
  return rows;
}
async function getOverdueTasks(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE user_id = $1 AND status IN ('pending', 'in_progress') AND due_date < CURRENT_DATE ORDER BY due_date ASC`, [String(userId)]);
  return rows;
}
async function getTasksByGoal(userId, goalId) {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE user_id = $1 AND goal_id = $2 ORDER BY status, priority`, [String(userId), goalId]);
  return rows;
}

/**
 * Get all tasks (including completed/cancelled) for analysis.
 * @param {string} userId
 * @param {string} since - ISO timestamp
 * @returns {Promise<Array>}
 */
async function getAllTasksForAnalysis(userId, since) {
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at DESC`,
    [String(userId), since]
  );
  return rows;
}

// ── Pattern Recognition ──────────────────────────────────────────────────────

/**
 * Save a tracking entry for incremental pattern detection.
 * @param {string} userId
 * @param {object} entry
 * @param {string} entry.role - 'user' or 'assistant'
 * @param {string} entry.content
 * @param {Array} entry.keywords
 * @param {string|null} entry.tool_used
 * @param {string} entry.created_at
 */
async function savePatternTracking(userId, entry) {
  await pool.query(
    `INSERT INTO pattern_tracking (user_id, role, content, keywords, tool_used, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      String(userId),
      entry.role,
      entry.content || '',
      JSON.stringify(entry.keywords || []),
      entry.tool_used || null,
      entry.created_at || new Date().toISOString(),
    ]
  );
}

/**
 * Get pattern tracking entries since a given date.
 * @param {string} userId
 * @param {string} since - ISO timestamp
 * @param {number} [limit=1000]
 * @returns {Promise<Array>}
 */
async function getPatternTracking(userId, since, limit = 1000) {
  const { rows } = await pool.query(
    `SELECT id, role, content, keywords, tool_used, created_at
     FROM pattern_tracking
     WHERE user_id = $1 AND created_at >= $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [String(userId), since, limit]
  );
  // Parse JSONB keywords field
  return rows.map(r => ({
    ...r,
    keywords: typeof r.keywords === 'string' ? JSON.parse(r.keywords) : (r.keywords || []),
  }));
}

/**
 * Save detected patterns (upsert by user_id + name).
 * @param {string} userId
 * @param {Array} patterns - array of pattern objects
 */
async function saveDetectedPatterns(userId, patterns) {
  for (const p of patterns) {
    await pool.query(
      `INSERT INTO detected_patterns (user_id, pattern_type, name, description, confidence, data, detected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (user_id, name) DO UPDATE
         SET description = $4, confidence = $5, data = $6, updated_at = NOW(), active = TRUE`,
      [
        String(userId),
        p.pattern_type,
        p.name,
        p.description || null,
        p.confidence || 0.5,
        JSON.stringify(p.data || {}),
      ]
    );
  }
}

/**
 * Get detected patterns for a user.
 * @param {string} userId
 * @param {object} [options]
 * @param {string} [options.type] - filter by pattern_type
 * @param {number} [options.minConfidence] - minimum confidence
 * @param {number} [options.limit=20]
 * @returns {Promise<Array>}
 */
async function getDetectedPatterns(userId, options = {}) {
  let query = `SELECT * FROM detected_patterns WHERE user_id = $1 AND active = TRUE`;
  const params = [String(userId)];
  let paramIdx = 2;

  if (options.type) {
    query += ` AND pattern_type = $` + paramIdx++;
    params.push(options.type);
  }
  if (options.minConfidence !== undefined) {
    query += ` AND confidence >= $` + paramIdx++;
    params.push(options.minConfidence);
  }

  query += ` ORDER BY confidence DESC, updated_at DESC LIMIT $` + paramIdx;
  params.push(options.limit || 20);

  const { rows } = await pool.query(query, params);
  return rows.map(r => ({
    ...r,
    data: typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {}),
  }));
}

/**
 * Mark patterns older than a TTL as inactive.
 * @param {string} userId
 * @param {number} ttlMs - time-to-live in milliseconds
 * @returns {Promise<number>} number deactivated
 */
async function cleanupExpiredPatterns(userId, ttlMs) {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const { rowCount } = await pool.query(
    `UPDATE detected_patterns SET active = FALSE
     WHERE user_id = $1 AND updated_at < $2 AND active = TRUE`,
    [String(userId), cutoff]
  );
  return rowCount;
}

/**
 * Prune old pattern tracking data beyond retention period.
 * @param {string} userId
 * @param {number} [keepDays=60]
 * @returns {Promise<number>}
 */
async function pruneOldPatternTracking(userId, keepDays = 60) {
  const { rowCount } = await pool.query(
    `DELETE FROM pattern_tracking
     WHERE user_id = $1 AND created_at < NOW() - ($2 || ' days')::INTERVAL`,
    [String(userId), String(keepDays)]
  );
  return rowCount;
}

// ── Relationships (People Memory) ────────────────────────────────────────────

/**
 * Add or update a person in the relationship memory.
 * @param {string} userId
 * @param {object} person
 * @param {string} person.name - person's name
 * @param {string} [person.relationship] - e.g. "friend", "colleague", "family", "spouse", "mentor"
 * @param {string} [person.context] - short summary of how/where user knows them
 * @param {string} [person.notes] - additional notes about this person
 * @param {number} [person.confidence] - 0.0 to 1.0
 * @returns {Promise<object>} the upserted row
 */
async function upsertRelationship(userId, { name, relationship, context, notes, confidence }) {
  const { rows } = await pool.query(
    `INSERT INTO relationships (user_id, name, relationship, context, notes, confidence, mention_count, first_mentioned_at, last_mentioned_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, NOW(), NOW(), NOW())
     ON CONFLICT (user_id, name) DO UPDATE
       SET relationship = COALESCE($3, relationships.relationship),
           context = COALESCE($4, relationships.context),
           notes = CASE WHEN $5 IS NOT NULL AND $5 <> '' THEN $5 ELSE relationships.notes END,
           confidence = COALESCE($6, relationships.confidence),
           mention_count = relationships.mention_count + 1,
           last_mentioned_at = NOW(),
           updated_at = NOW()
     RETURNING *`,
    [String(userId), name, relationship || null, context || null, notes || null, confidence || null]
  );
  return rows[0];
}

/**
 * Get all relationships for a user, sorted by most recently mentioned.
 * @param {string} userId
 * @param {number} [limit=50]
 * @returns {Promise<Array>}
 */
async function getRelationships(userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT * FROM relationships
     WHERE user_id = $1
     ORDER BY last_mentioned_at DESC
     LIMIT $2`,
    [String(userId), limit]
  );
  return rows;
}

/**
 * Get a specific person by name.
 * @param {string} userId
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function getRelationshipByName(userId, name) {
  const { rows } = await pool.query(
    `SELECT * FROM relationships WHERE user_id = $1 AND LOWER(name) = LOWER($2)`,
    [String(userId), name]
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Delete a relationship entry.
 * @param {string} userId
 * @param {string} name
 */
async function deleteRelationship(userId, name) {
  await pool.query(
    `DELETE FROM relationships WHERE user_id = $1 AND LOWER(name) = LOWER($2)`,
    [String(userId), name]
  );
}

/**
 * Search relationships by name or context.
 * @param {string} userId
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Promise<Array>}
 */
async function searchRelationships(userId, query, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM relationships
     WHERE user_id = $1
       AND (name ILIKE '%' || $2 || '%' OR relationship ILIKE '%' || $2 || '%' OR context ILIKE '%' || $2 || '%')
     ORDER BY last_mentioned_at DESC
     LIMIT $3`,
    [String(userId), query, limit]
  );
  return rows;
}

/**
 * Get people mentioned in a date range (for reflection/pattern analysis).
 * @param {string} userId
 * @param {string} since - ISO timestamp
 * @returns {Promise<Array>}
 */
async function getRecentlyMentionedPeople(userId, since) {
  const { rows } = await pool.query(
    `SELECT * FROM relationships
     WHERE user_id = $1 AND last_mentioned_at >= $2
     ORDER BY last_mentioned_at DESC`,
    [String(userId), since]
  );
  return rows;
}

// ── Bot State Persistence ───────────────────────────────────────────────────
// Used by the persistence module to save/restore executive runtime state
// (working memory, world model, lifecycle, planner) across restarts.

/**
 * Save a bot state snapshot for a user. Upserts on (user_id, state_type).
 * @param {string} userId
 * @param {string} stateType - e.g. 'working_memory', 'world_model', 'lifecycle', 'planner'
 * @param {object} stateData - JSON-serializable state data
 */
async function saveBotState(userId, stateType, stateData) {
  await pool.query(
    `INSERT INTO bot_state (user_id, state_type, state_data, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, state_type) DO UPDATE
       SET state_data = $3, updated_at = NOW()`,
    [String(userId), stateType, JSON.stringify(stateData)]
  );
}

/**
 * Load a specific bot state for a user.
 * @param {string} userId
 * @param {string} stateType
 * @returns {Promise<object|null>} parsed state data or null if not found
 */
async function loadBotState(userId, stateType) {
  const { rows } = await pool.query(
    `SELECT state_data, updated_at FROM bot_state
     WHERE user_id = $1 AND state_type = $2`,
    [String(userId), stateType]
  );
  if (rows.length === 0) return null;
  return {
    ...(typeof rows[0].state_data === 'string' ? JSON.parse(rows[0].state_data) : rows[0].state_data),
    _savedAt: rows[0].updated_at,
  };
}

/**
 * Load all bot states for a user.
 * @param {string} userId
 * @returns {Promise<object>} map of stateType → stateData
 */
async function loadAllBotStates(userId) {
  const { rows } = await pool.query(
    `SELECT state_type, state_data, updated_at FROM bot_state
     WHERE user_id = $1`,
    [String(userId)]
  );
  const states = {};
  for (const row of rows) {
    states[row.state_type] = {
      ...(typeof row.state_data === 'string' ? JSON.parse(row.state_data) : row.state_data),
      _savedAt: row.updated_at,
    };
  }
  return states;
}

/**
 * Delete a bot state entry.
 * @param {string} userId
 * @param {string} stateType
 */
async function deleteBotState(userId, stateType) {
  await pool.query(
    `DELETE FROM bot_state WHERE user_id = $1 AND state_type = $2`,
    [String(userId), stateType]
  );
}

// ── Streaks ──────────────────────────────────────────────────────────────────

/**
 * Record an activity for streak tracking. Updates the streak counters.
 * If activity was yesterday → increments streak. If today → no change.
 * If gap > 1 day → resets to 1.
 * @param {string} userId
 * @param {'daily_chat'|'task_completed'|'morning_briefing'|'reflection'} streakType
 * @returns {Promise<{current_streak: number, longest_streak: number, isNewDay: boolean}>}
 */
async function recordStreakActivity(userId, streakType) {
  const tz = process.env.TIMEZONE || 'UTC';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

  const { rows } = await pool.query(
    `SELECT * FROM streaks WHERE user_id = $1 AND streak_type = $2`,
    [String(userId), streakType]
  );

  let currentStreak = 1;
  let longestStreak = 1;
  let isNewDay = true;

  if (rows.length > 0) {
    const existing = rows[0];
    const lastDate = existing.last_activity_date
      ? new Date(existing.last_activity_date).toLocaleDateString('en-CA', { timeZone: tz })
      : null;

    if (lastDate === today) {
      return {
        current_streak: existing.current_streak,
        longest_streak: existing.longest_streak,
        isNewDay: false,
      };
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: tz });

    if (lastDate === yesterdayStr) {
      currentStreak = existing.current_streak + 1;
      longestStreak = Math.max(currentStreak, existing.longest_streak);
    } else {
      currentStreak = 1;
      longestStreak = existing.longest_streak;
    }
  }

  await pool.query(
    `INSERT INTO streaks (user_id, streak_type, current_streak, longest_streak, last_activity_date, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, streak_type) DO UPDATE
       SET current_streak = $3,
           longest_streak = GREATEST(streaks.longest_streak, $4),
           last_activity_date = $5,
           updated_at = NOW()`,
    [String(userId), streakType, currentStreak, longestStreak, today]
  );

  return { current_streak: currentStreak, longest_streak: longestStreak, isNewDay };
}

/**
 * Get all streak stats for a user.
 * @param {string} userId
 * @returns {Promise<Array<{streak_type:string, current_streak:number, longest_streak:number, last_activity_date:string}>>}
 */
async function getStreaks(userId) {
  const { rows } = await pool.query(
    `SELECT streak_type, current_streak, longest_streak, last_activity_date
     FROM streaks WHERE user_id = $1
     ORDER BY current_streak DESC`,
    [String(userId)]
  );
  return rows;
}

/**
 * Check if a streak has already been recorded today.
 * @param {string} userId
 * @param {string} streakType
 * @returns {Promise<boolean>}
 */
async function isStreakRecordedToday(userId, streakType) {
  const tz = process.env.TIMEZONE || 'UTC';
  const { rows } = await pool.query(
    `SELECT last_activity_date FROM streaks
     WHERE user_id = $1 AND streak_type = $2`,
    [String(userId), streakType]
  );
  if (rows.length === 0) return false;
  const lastDate = rows[0].last_activity_date
    ? new Date(rows[0].last_activity_date).toLocaleDateString('en-CA', { timeZone: tz })
    : null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  return lastDate === today;
}

module.exports = {
  pool,
  retryQuery,
  ensureUser,
  getUserName,
  createReminder,
  getPendingReminders,
  markReminderSent,
  getTodayReminders,
  getUpcomingReminders,
  getOverdueReminders,
  cancelReminder,
  updateReminder,
  rescheduleRecurring,
  snoozeReminder,
  createEvent,
  getTodayEvents,
  cancelEvent,
  updateEvent,
  addNote,
  deleteNote,
  getRecentNotes,
  setFact,
  getAllFacts,
  deleteFact,
  getFullMemory,
  getNotesSince,
  getRemindersDueInRange,
  getUpcomingRemindersNextWeek,
  getSetting,
  getAllSettings,
  setSetting,
  getConfig,
  // Chat history
  saveChatMessage,
  getRecentChatHistory,
  searchChatHistory,
  getChatHistoryInRange,
  pruneOldChatHistory,
  getChatActivitySummary,
  // Confidence & conflict
  updateFactConfidence,
  flagFactConflict,
  resolveFactConflict,
  getConflictFacts,
  // Reflections
  saveReflection,
  getRecentReflections,
  getTodayReflection,
  // Tasks & Goals
  createGoal, updateGoal, completeGoal, abandonGoal, getActiveGoals, getAllGoals,
  createTask, updateTask, startTask, completeTask, cancelTask, getTasksByStatus, getActiveTasks, getOverdueTasks, getTasksByGoal,
  getAllTasksForAnalysis,
  // Pattern Recognition
  savePatternTracking,
  getPatternTracking,
  saveDetectedPatterns,
  getDetectedPatterns,
  cleanupExpiredPatterns,
  pruneOldPatternTracking,
  // Relationships
  upsertRelationship,
  getRelationships,
  getRelationshipByName,
  deleteRelationship,
  searchRelationships,
  getRecentlyMentionedPeople,
  // Bot State Persistence
  saveBotState,
  loadBotState,
  loadAllBotStates,
  deleteBotState,
  // Streaks
  recordStreakActivity,
  getStreaks,
  isStreakRecordedToday,
};
