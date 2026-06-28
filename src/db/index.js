// src/db/index.js
// Central database connection pool
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  console.error('Unexpected DB error:', err.message);
});

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

// ── Notes ─────────────────────────────────────────────────────────────────────

async function addNote(userId, content) {
  const { rows } = await pool.query(
    `INSERT INTO notes (user_id, content) VALUES ($1, $2) RETURNING *`,
    [String(userId), content]
  );
  return rows[0];
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
    `SELECT key, value FROM memory_facts WHERE user_id = $1`,
    [String(userId)]
  );
  return rows;
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

module.exports = {
  pool,
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
  createEvent,
  getTodayEvents,
  addNote,
  getRecentNotes,
  setFact,
  getAllFacts,
  getFullMemory,
  getNotesSince,
  getRemindersDueInRange,
  getUpcomingRemindersNextWeek,
  getSetting,
  getAllSettings,
  setSetting,
  getConfig,
};
