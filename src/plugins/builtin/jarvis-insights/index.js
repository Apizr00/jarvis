// plugins/builtin/jarvis-insights/index.js
// ── Jarvis Insights Plugin ──────────────────────────────────────────────────
//
// A built-in plugin demonstrating the plugin system. Provides:
//   - /insights  — show usage patterns and stats
//   - /mood      — track and show mood trends
//   - /weekly    — generate a weekly summary
//
// This plugin hooks into the message flow to track mood and activity,
// and provides commands that users can invoke.

// ── In-plugin state (persisted to DB via set_fact) ─────────────────────────
let moodLog = [];        // [{mood: string, timestamp: ISO}]
let messageCount = 0;
let ctx = null;

// ── Mood Keywords ──────────────────────────────────────────────────────────

const MOOD_KEYWORDS = {
  happy: ['gembira', 'happy', 'seronok', 'best', 'bagus', 'baik', 'hebat', 'alhamdulillah', 'syukur', 'awesome', 'great', 'nice', 'wow', 'yay', '🥳', '😊', '😄', '🎉'],
  sad: ['sedih', 'sad', 'kecewa', 'down', 'murung', 'menangis', 'tangis', '😢', '😔', '💔'],
  stressed: ['stress', 'tekanan', 'penat', 'letih', 'busy', 'sibuk', 'banyak kerja', 'tired', 'exhausted', '😫', '😩', '😤'],
  motivated: ['semangat', 'motivated', 'bersemangat', 'boleh', 'yakin', 'confident', 'go', 'jom', '💪', '🔥', '🚀'],
  curious: ['kenapa', 'why', 'macam mana', 'how', 'apa itu', 'what is', 'bagaimana', 'terangkan', 'explain', '🤔'],
  grateful: ['terima kasih', 'thank', 'thanks', 'good job', 'bagus', 'appreciate', '🙏'],
};

function detectMood(message) {
  const lower = message.toLowerCase();
  const scores = {};

  for (const [mood, keywords] of Object.entries(MOOD_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > 0) scores[mood] = score;
  }

  if (Object.keys(scores).length === 0) return null;

  // Return the mood with the highest score
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

// ── Plugin Hooks ────────────────────────────────────────────────────────────

/**
 * Called once when the plugin is initialized.
 */
async function onInit(pluginCtx) {
  ctx = pluginCtx;
  ctx.logger.info('Initializing Jarvis Insights plugin');

  // Load persisted mood data
  try {
    const facts = await ctx.memory.searchFacts(ctx.userId || process.env.TELEGRAM_OWNER_ID, 'insights_mood_log', 1);
    if (facts && facts.length > 0) {
      try {
        moodLog = JSON.parse(facts[0].value || '[]');
      } catch { moodLog = []; }
    }
    const countFact = await ctx.memory.searchFacts(ctx.userId || process.env.TELEGRAM_OWNER_ID, 'insights_message_count', 1);
    if (countFact && countFact.length > 0) {
      messageCount = parseInt(countFact[0].value || '0', 10) || 0;
    }
  } catch (err) {
    ctx.logger.warn('Could not load persisted state:', err.message);
  }

  ctx.logger.info('Loaded ' + moodLog.length + ' mood entries, ' + messageCount + ' messages tracked');

  // ── Register Playground Widgets ───────────────────────────────────────
  if (typeof ctx.registerWidget === 'function') {
    // Mood chart widget
    ctx.registerWidget({
      id: 'mood-chart',
      title: 'Mood Tracker',
      icon: '📊',
      type: 'chart',
      description: 'Carta mood harian berdasarkan interaksi dengan Jarvis.',
      defaultSize: { w: 2, h: 1 },
      refreshInterval: 600000, // 10 minutes
      endpoint: '/api/plugins/jarvis-insights/mood-data',
      config: { chartType: 'bar' },
    });

    // Weekly summary widget
    ctx.registerWidget({
      id: 'weekly-summary',
      title: 'Weekly Summary',
      icon: '📋',
      type: 'card',
      description: 'Ringkasan mingguan interaksi dan aktiviti.',
      defaultSize: { w: 2, h: 1 },
      refreshInterval: 3600000, // 1 hour
      endpoint: '/api/plugins/jarvis-insights/weekly-data',
      config: {},
    });

    // Usage stats widget
    ctx.registerWidget({
      id: 'usage-stats',
      title: 'Usage Stats',
      icon: '📈',
      type: 'list',
      description: 'Statistik penggunaan Jarvis.',
      defaultSize: { w: 1, h: 1 },
      refreshInterval: 300000, // 5 minutes
      endpoint: '/api/plugins/jarvis-insights/usage-data',
      config: {},
    });

    ctx.logger.info('Insights widgets registered for playground');
  }
}

/**
 * Called on every user message. Tracks mood and activity.
 */
async function onMessage(messageCtx) {
  const { userId, message } = messageCtx;
  if (!message) return;

  messageCount++;

  // Detect mood from message
  if (ctx.config.moodTracking !== false) {
    const mood = detectMood(message);
    if (mood) {
      moodLog.push({
        mood,
        timestamp: new Date().toISOString(),
        messagePreview: message.slice(0, 50),
      });

      // Keep only last 500 entries
      if (moodLog.length > 500) {
        moodLog = moodLog.slice(-500);
      }

      // Persist every 5 mood entries
      if (moodLog.length % 5 === 0) {
        await persistState(userId);
      }
    }
  }

  // Persist counters every 50 messages
  if (messageCount % 50 === 0) {
    await persistState(userId);
  }

  return null; // Don't intercept — let message flow normally
}

/**
 * Handle plugin commands: /insights, /mood, /weekly
 */
async function onCommand(cmdCtx) {
  const { command, args, userId, bot } = cmdCtx;

  switch (command) {
    case '/insights':
      return await handleInsights(userId);
    case '/mood':
      return await handleMood(userId, args);
    case '/weekly':
      return await handleWeekly(userId);
    default:
      return { text: 'Unknown insights command.' };
  }
}

/**
 * Listen to system events for cross-plugin awareness.
 */
function onEvent(eventName, payload) {
  // Track when reminders fire (for activity correlation)
  if (eventName === 'reminder:fired') {
    ctx.logger.debug('Reminder fired: ' + payload.text);
  }
}

// ── Command Handlers ────────────────────────────────────────────────────────

async function handleInsights(userId) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // Count today's mood entries
  const todayMoods = moodLog.filter(m => m.timestamp.startsWith(today));

  // Get mood distribution
  const moodDist = {};
  for (const entry of moodLog) {
    moodDist[entry.mood] = (moodDist[entry.mood] || 0) + 1;
  }

  // Sort moods by frequency
  const topMoods = Object.entries(moodDist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Get message stats from DB
  let totalReminders = 0, totalTasks = 0;
  try {
    const reminders = await ctx.db.getAllReminders(userId);
    totalReminders = reminders?.length || 0;
    const tasks = await ctx.db.listTasks(userId);
    totalTasks = tasks?.length || 0;
  } catch { /* ignore */ }

  const lines = [
    '📊 *Jarvis Insights*',
    '',
    '📝 Messages tracked: *' + messageCount + '*',
    '😊 Mood entries: *' + moodLog.length + '*',
    '📌 Today\'s mood checks: *' + todayMoods.length + '*',
    '⏰ Active reminders: *' + totalReminders + '*',
    '✅ Active tasks: *' + totalTasks + '*',
    '',
  ];

  if (topMoods.length > 0) {
    lines.push('🎭 *Top Moods:*');
    const moodEmojis = { happy: '😊', sad: '😢', stressed: '😫', motivated: '💪', curious: '🤔', grateful: '🙏' };
    for (const [mood, count] of topMoods) {
      const emoji = moodEmojis[mood] || '•';
      const pct = ((count / moodLog.length) * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(count / Math.max(...Object.values(moodDist)) * 10));
      lines.push('  ' + emoji + ' *' + mood + '*: ' + bar + ' ' + pct + '%');
    }
  }

  return { text: lines.join('\n'), parseMode: 'Markdown' };
}

async function handleMood(userId, args) {
  if (args && args.length > 0) {
    // Manual mood logging: /mood happy
    const mood = args[0].toLowerCase();
    if (MOOD_KEYWORDS[mood]) {
      moodLog.push({
        mood,
        timestamp: new Date().toISOString(),
        messagePreview: '[manual entry]',
      });
      await persistState(userId);
      return { text: '✅ Mood logged: *' + mood + '* 🎭', parseMode: 'Markdown' };
    } else {
      const validMoods = Object.keys(MOOD_KEYWORDS).join(', ');
      return { text: '❌ Unknown mood. Try: ' + validMoods };
    }
  }

  // Show mood trend (last 7 days)
  const now = new Date();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const recentMoods = moodLog.filter(m => new Date(m.timestamp) >= sevenDaysAgo);

  if (recentMoods.length === 0) {
    return { text: '📭 No mood data yet. Keep chatting and I\'ll track your mood! Use `/mood happy` to log manually.' };
  }

  // Group by day
  const byDay = {};
  for (const entry of recentMoods) {
    const day = entry.timestamp.split('T')[0];
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(entry.mood);
  }

  const lines = ['🎭 *Mood Trend — Last 7 Days*', ''];

  const moodEmojis = { happy: '😊', sad: '😢', stressed: '😫', motivated: '💪', curious: '🤔', grateful: '🙏' };

  for (const [day, moods] of Object.entries(byDay).sort()) {
    // Get dominant mood for the day
    const moodCount = {};
    for (const m of moods) moodCount[m] = (moodCount[m] || 0) + 1;
    const dominant = Object.entries(moodCount).sort((a, b) => b[1] - a[1])[0][0];
    const emoji = moodEmojis[dominant] || '•';

    const dateLabel = new Date(day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    lines.push(emoji + ' *' + dateLabel + '* — ' + dominant + ' (' + moods.length + ' signals)');
  }

  // Overall dominant mood
  const allMoods = recentMoods.map(m => m.mood);
  const overallCount = {};
  for (const m of allMoods) overallCount[m] = (overallCount[m] || 0) + 1;
  const overallDominant = Object.entries(overallCount).sort((a, b) => b[1] - a[1])[0];

  lines.push('');
  lines.push('📈 *Overall:* Mostly *' + overallDominant[0] + '* this week');

  return { text: lines.join('\n'), parseMode: 'Markdown' };
}

async function handleWeekly(userId) {
  const now = new Date();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const recentMoods = moodLog.filter(m => new Date(m.timestamp) >= sevenDaysAgo);

  let totalReminders = 0, totalTasks = 0, completedTasks = 0;
  try {
    const reminders = await ctx.db.getAllReminders(userId);
    totalReminders = reminders?.length || 0;
    const tasks = await ctx.db.listTasks(userId);
    totalTasks = tasks?.length || 0;
    completedTasks = tasks?.filter(t => t.status === 'completed').length || 0;
  } catch { /* ignore */ }

  // Calculate mood distribution
  const moodDist = {};
  for (const entry of recentMoods) {
    moodDist[entry.mood] = (moodDist[entry.mood] || 0) + 1;
  }

  const lines = [
    '📋 *Weekly Summary*',
    '',
    '📅 ' + new Date(sevenDaysAgo).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' — ' + new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    '',
    '💬 *Activity*',
    '  • Messages tracked: ' + messageCount,
    '  • Mood signals detected: ' + recentMoods.length,
    '',
    '📋 *Productivity*',
    '  • Active reminders: ' + totalReminders,
    '  • Active tasks: ' + totalTasks,
    '  • Completed tasks: ' + completedTasks,
    '',
  ];

  if (Object.keys(moodDist).length > 0) {
    lines.push('🎭 *Mood Breakdown*');
    const sorted = Object.entries(moodDist).sort((a, b) => b[1] - a[1]);
    const maxCount = sorted[0][1];
    for (const [mood, count] of sorted) {
      const bar = '▓'.repeat(Math.round((count / maxCount) * 10));
      lines.push('  ' + bar + ' ' + mood + ' (' + count + ')');
    }
  }

  return { text: lines.join('\n'), parseMode: 'Markdown' };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function persistState(userId) {
  try {
    const uid = userId || process.env.TELEGRAM_OWNER_ID;
    if (!uid) return;
    await ctx.memory.setFact(uid, 'insights_mood_log', JSON.stringify(moodLog.slice(-500)));
    await ctx.memory.setFact(uid, 'insights_message_count', String(messageCount));
  } catch (err) {
    ctx.logger.warn('Persist failed:', err.message);
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

async function onDisable() {
  ctx.logger.info('Jarvis Insights disabled');
}

async function onUnload() {
  ctx.logger.info('Jarvis Insights unloaded');
  ctx = null;
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  onInit,
  onMessage,
  onCommand,
  onEvent,
  onDisable,
  onUnload,
};
