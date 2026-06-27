// src/index.js
// Entry point - boots bot, API server, and scheduler
require('dotenv').config();

const { createBot } = require('./bot');
const { createApiServer } = require('./api');
const { startScheduler } = require('./scheduler');

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
  console.log('  🤖  J A R V I S  —  Personal AI Assistant v1.0  🤖');
  console.log('');

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
