// src/index.js
// Entry point - boots bot, API server, scheduler, Redis, event bus, agents, and plugins
require('dotenv').config();

const { logger, errorMetrics } = require('./utils/logger');
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
const persistence = require('./executive/persistence');
const queueSystem = require('./queue');

// ── Global Error Handlers (uncaught exceptions & unhandled rejections) ────────
process.on('uncaughtException', (err) => {
  logger.fatal('Uncaught Exception — process will exit', {
    error: err.message,
    stack: err.stack?.split('\n').slice(0, 5),
    origin: 'uncaughtException',
  });
  console.error('💥 UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    error: reason?.message || String(reason),
    stack: reason?.stack?.split('\n').slice(0, 5),
    origin: 'unhandledRejection',
  });
  console.error('⚠️  UNHANDLED REJECTION:', reason);
  // Don't exit — allow the process to continue but log aggressively
});

// ── Validate required env vars ────────────────────────────────────────────────
const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'DEEPSEEK_API_KEY', 'DATABASE_URL'];
const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  logger.fatal('Missing required environment variables', { missing });
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

  logger.info('Jarvis starting up', { nodeVersion: process.version });

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

  // ── Initialize Job Queue System ─────────────────────────────────────
  await queueSystem.init();

  // ── Initialize Persistence Layer ───────────────────────────────────────
  // Wire up executive modules so the persistence orchestrator can call
  // their serialize/hydrate methods.
  const workingMemory = require('./executive/working-memory');
  const worldModel = require('./executive/world-model');
  const lifecycle = require('./executive/lifecycle');
  const planner = require('./executive/planner');
  persistence.initModules(workingMemory, worldModel, lifecycle, planner);

  // ── Load persisted state from DB ───────────────────────────────────────
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  await persistence.loadAll(ownerId);

  // Start Telegram bot
  const bot = await createBot();

  // ── Start Queue Workers (after all modules are loaded) ──────────────────
  // Inject handlers so workers can execute background jobs.
  const qMemory = require('./memory');
  const qRelationships = require('./memory/relationships');
  const qDomains = require('./memory/domains');
  const qPatterns = require('./patterns');
  const qLlm = require('./llm');

  queueSystem.startWorkers({
    extractFacts: (userId, userText, botResponse) =>
      qMemory.extractFactsFromChat(userId, userText, botResponse, qLlm.chatMimo),
    extractPeople: (userId, userText, botResponse) =>
      qRelationships.extractPeopleFromChat(userId, userText, botResponse, qLlm.chatMimo),
    trackPattern: (userId, entry) =>
      qPatterns.trackMessage(userId, entry),
    updateDomains: async (userId, text) => {
      const activeDomain = qDomains.detectActiveDomain(text);
      worldModel.update(userId, { activeDomain: activeDomain.domain });
    },
    evaluateQuality: (userId, evalData) => {
      const evaluator = require('./executive/evaluator');
      const quality = evaluator.evaluateResponseQuality(evalData);
      evaluator.recordInteraction(userId, {
        tier: evalData.tier,
        category: evalData.category,
        quality: quality.score,
        toolName: evalData.toolName,
        toolSuccess: evalData.toolSuccess,
      });
    },
    smartSummarize: async (userId, history) => {
      const { generateSmartSummary } = require('./bot/history');
      return generateSmartSummary(userId, history, qLlm.chatIlmu || qLlm.chatMimo);
    },
    updateWorkingMemory: (userId, wmData) => {
      workingMemory.update(userId, wmData);
    },
    patternAnalysis: (userId, options) =>
      qPatterns.runFullAnalysis(userId, options),
    memoryCleanup: (userId) =>
      qMemory.autoCleanupFacts(userId, 3, 30),
    chatPrune: (userId, days) =>
      qMemory.pruneOldHistory(userId, days),
    lifecycleIdle: (userId) =>
      lifecycle.evaluateIdle(userId),
    generateReflection: async (userId) => {
      const reflection = await qMemory.generateDailyReflection(userId, qLlm.chatMimo);
      if (reflection && bot) {
        try {
          await bot.sendMessage(userId, '*🧘 Daily Reflection*\n\n' + reflection, { parse_mode: 'Markdown' });
        } catch {
          await bot.sendMessage(userId, '🧘 Daily Reflection\n\n' + reflection);
        }
        return true;
      }
      return false;
    },
    generateBriefing: async (userId) => {
      const { buildBriefingMessage } = require('./scheduler');
      const briefing = await buildBriefingMessage(userId);
      if (briefing && bot) {
        await bot.sendMessage(userId, briefing, { parse_mode: 'Markdown' });
        return true;
      }
      return false;
    },
  });

  // Start reminder scheduler (needs the bot instance to send messages)
  await startScheduler(bot);

  // ── Start auto-save (checkpoints every 5 minutes) ──────────────────────
  persistence.startAutoSave(ownerId);

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

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info('Shutting down Jarvis...', { signal, uptime: process.uptime() });
    console.log('\n👋 Shutting down Jarvis...');
    eventBus.emitSync(EVENTS.SYSTEM_SHUTDOWN, { reason: signal });
    await queueSystem.shutdown();
    await persistence.stopAutoSave(ownerId); // final checkpoint
    await pluginRegistry.shutdown();
    await agentRegistry.shutdown();
    eventBus.stop();
    logger.info('Jarvis shut down successfully', { signal });
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  logger.fatal('Fatal startup error', { error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
  console.error('❌ Fatal startup error:', err.message);
  process.exit(1);
});
