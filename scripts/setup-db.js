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
  `);

  console.log('✅ All tables created successfully!');
  await pool.end();
}

setup().catch(err => {
  console.error('❌ Setup failed:', err.message);
  process.exit(1);
});
