// src/index.js
// Entry point - boots bot, API server, scheduler, Redis, event bus, agents, and plugins
require('dotenv').config();

const redis = require('./redis');
const db = require('./db');
const { createBot } = require('./bot');
const { createApiServer } = require('./api');
const { startScheduler } = require('./scheduler');
const { getApiStatus, formatStatusMessage } = require('./api/status');
const { formatFeaturesCompact } = require('./api/features');
const { eventBus, EVENTS } = require('./events');
const { agentRegistry } = require('./agents');
const { pluginRegistry } = require('./plugins');

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
  const botName = (await db.getConfig(process.env.TELEGRAM_OWNER_ID, 'bot_name', 'BOT_NAME', 'JARVIS')).toUpperCase();
  console.log('  🤖  ' + botName + '  —  Personal AI Assistant v3.0  🤖');
  console.log('');

  // ── 1. Start Event Bus ─────────────────────────────────────────────────
  eventBus.start();
  console.log('📡 Event Bus started');

  // ── 2. Initialize Agent Layer ──────────────────────────────────────────
  await agentRegistry.initAll();
  console.log('🤖 Agent Layer initialized (' + agentRegistry.getAll().length + ' agents)');

  // ── 3. Discover & Initialize Plugins ───────────────────────────────────
  await pluginRegistry.discover();
  const pluginInitResult = await pluginRegistry.initAll();
  console.log('🔌 Plugin System: ' + pluginInitResult.loaded + ' loaded, ' + pluginInitResult.failed + ' failed');

  // Connect Redis
  await redis.connect();

  // Start Telegram bot
  const bot = await createBot();

  // Start reminder scheduler (needs the bot instance to send messages)
  await startScheduler(bot);

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

  // ── Event Bus & Plugin status ──────────────────────────────────────────
  const ebStatus = eventBus.getStatus();
  const plStatus = pluginRegistry.getStatus();
  const agStatus = agentRegistry.getStatus();

  console.log('');
  console.log('📡 EVENT BUS');
  console.log('────────────');
  console.log('  Listeners: ' + ebStatus.listenerCount + ' | Events: ' + ebStatus.registeredEvents.length + ' | Recent: ' + ebStatus.recentEventCount);

  console.log('');
  console.log('🤖 AGENTS');
  console.log('─────────');
  for (const agent of agStatus.agents) {
    const statusIcon = agent.status === 'idle' ? '💤' : agent.status === 'running' ? '🟢' : '🔴';
    console.log('  ' + statusIcon + ' ' + agent.name.padEnd(16) + ' — ' + agent.description.slice(0, 50));
  }

  console.log('');
  console.log('🔌 PLUGINS');
  console.log('──────────');
  if (plStatus.plugins.length === 0) {
    console.log('  (no external plugins loaded)');
  }
  for (const p of plStatus.plugins) {
    const sIcon = p.state === 'enabled' ? '✅' : p.state === 'disabled' ? '🔒' : p.state === 'error' ? '❌' : '⏳';
    console.log('  ' + sIcon + ' ' + p.name + ' v' + p.version + ' [' + p.state + ']');
  }
  console.log('');

  console.log('✅ Jarvis is fully operational.');
  console.log('');
  console.log('🧩 ACTIVE MODULES');
  console.log('─────────────────');
  console.log(formatFeaturesCompact());
  console.log('');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down Jarvis...');
    eventBus.emitSync(EVENTS.SYSTEM_SHUTDOWN, { reason: 'SIGINT' });
    await pluginRegistry.shutdown();
    await agentRegistry.shutdown();
    eventBus.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    eventBus.emitSync(EVENTS.SYSTEM_SHUTDOWN, { reason: 'SIGTERM' });
    await pluginRegistry.shutdown();
    await agentRegistry.shutdown();
    eventBus.stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('❌ Fatal startup error:', err.message);
  process.exit(1);
});
