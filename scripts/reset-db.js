// scripts/reset-db.js
// ⚠️  WARNING: Drops ALL data and recreates tables from scratch.
// Run: node scripts/reset-db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function reset() {
  console.log('⚠️  This will DELETE ALL DATA in the Jarvis database.');
  console.log('   Database:', process.env.DATABASE_URL.replace(/\/\/.*@/, '//***@'));
  console.log('');

  // Drop all tables (order matters for foreign keys)
  console.log('🗑️  Dropping all tables...');
  await pool.query(`
    DROP TABLE IF EXISTS reflections CASCADE;
    DROP TABLE IF EXISTS tasks CASCADE;
    DROP TABLE IF EXISTS goals CASCADE;
    DROP TABLE IF EXISTS chat_history CASCADE;
    DROP TABLE IF EXISTS settings CASCADE;
    DROP TABLE IF EXISTS memory_facts CASCADE;
    DROP TABLE IF EXISTS notes CASCADE;
    DROP TABLE IF EXISTS events CASCADE;
    DROP TABLE IF EXISTS reminders CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);
  console.log('✅ All tables dropped.');

  await pool.end();

  // Re-run setup
  console.log('🔧 Re-creating tables...');
  require('./setup-db');
}

reset().catch(err => {
  console.error('❌ Reset failed:', err.message);
  process.exit(1);
});
