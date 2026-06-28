// scripts/setup-db.js
// Run once: node scripts/setup-db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function setup() {
  console.log('🔧 Setting up Jarvis database...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      text TEXT NOT NULL,
      remind_at TIMESTAMPTZ NOT NULL,
      status TEXT DEFAULT 'pending',
      recurrence TEXT DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      title TEXT NOT NULL,
      event_time TIMESTAMPTZ NOT NULL,
      duration_minutes INT DEFAULT 60,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notes (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS memory_facts (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_chat_history_user_time
      ON chat_history (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS reflections (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      summary TEXT NOT NULL,
      pattern_insights TEXT,
      fact_changes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, date)
    );
  `);

  // ── Migration: add recurrence column for existing databases ─────────────
  try {
    await pool.query(`ALTER TABLE reminders ADD COLUMN IF NOT EXISTS recurrence TEXT DEFAULT NULL`);
  } catch {
    // column already exists — safe to ignore
  }

  // ── Migration: add importance & access tracking for memory facts ─────────
  try {
    await pool.query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS importance INTEGER DEFAULT 5`);
  } catch { /* ignore */ }
  try {
    await pool.query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0`);
  } catch { /* ignore */ }
  try {
    await pool.query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ`);
  } catch { /* ignore */ }
  try {
    await pool.query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 0.7`);
  } catch { /* ignore */ }
  try {
    await pool.query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS conflict_flag BOOLEAN DEFAULT FALSE`);
  } catch { /* ignore */ }
  try {
    await pool.query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS previous_value TEXT`);
  } catch { /* ignore */ }

  console.log('✅ All tables created successfully!');
  await pool.end();
}

setup().catch(err => {
  console.error('❌ Setup failed:', err.message);
  process.exit(1);
});
