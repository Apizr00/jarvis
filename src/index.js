// src/index.js
// Entry point - boots bot, API server, scheduler, and Redis
require('dotenv').config();

const redis = require('./redis');
const { createBot } = require('./bot');
const { createApiServer } = require('./api');
const { startScheduler } = require('./scheduler');
const { getApiStatus, formatStatusMessage } = require('./api/status');

// ── Validate required env vars ────────────────────────────────────────────────
const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'DEEPSEEK_API_KEY', 'DATABASE_URL'];
const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  console.error('   Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗');
  console.log('       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝');
  console.log('       ██║███████║██████╔╝██║   ██║██║███████╗');
  console.log('  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║');
  console.log('  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║');
  console.log('   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝');
  console.log('');
  console.log('  🤖  J A R V I S  —  Personal AI Assistant v2.0  🤖');
  console.log('');

  // Connect Redis
  await redis.connect();

  // Start Telegram bot
  const bot = createBot();

  // Start reminder scheduler (needs the bot instance to send messages)
  startScheduler(bot);

  // Start REST API
  const app = createApiServer();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log('🌐 API server running on http://localhost:' + port);
  });

  // ── Check API status ────────────────────────────────────────────────────────
  console.log('');
  console.log('🔌 API STATUS');
  console.log('─────────────');
  const statuses = await getApiStatus(bot);
  for (const s of statuses) {
    const icon = s.icon || '•';
    const label = s.connected !== null
      ? (s.connected ? '\x1b[32monline\x1b[0m ' : '\x1b[31moffline\x1b[0m')
      : (s.configured ? 'untested' : '\x1b[90mn/a\x1b[0m     ');
    const padded = (icon + '  ' + s.name + ' ').padEnd(32, '.');
    console.log('  ' + padded + ' ' + label);
  }
  console.log('✅ Jarvis is fully operational.');
  console.log('');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down Jarvis...');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    process.exit(0);
  });
}

main().catch(err => {
  console.error('❌ Fatal startup error:', err.message);
  process.exit(1);
});
