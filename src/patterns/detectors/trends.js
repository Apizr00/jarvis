// src/patterns/detectors/trends.js
// ── Trend & Correlation Detector ─────────────────────────────────────────────
// Detects changes over time and correlations between dimensions:
//   - Activity volume trends (increasing/decreasing engagement)
//   - Topic shifts (moving from one theme to another)
//   - Feature adoption (starting to use new tools)
//   - Time-of-day ↔ Topic correlations
//   - Anomaly detection (unusual spikes or dips)

const { mean, stdDev, zScore, MIN_DATA_POINTS } = require('../shared');

/**
 * Detect trend and correlation patterns.
 * @param {string} userId
 * @param {object} dataContext
 * @returns {Promise<Array>}
 */
async function detectTrends(userId, dataContext) {
  const { trackingData, chatActivity, reminders, tasks, notes, lookbackDays } = dataContext;
  const patterns = [];

  if (!trackingData || trackingData.length < MIN_DATA_POINTS) return patterns;

  const userMessages = trackingData.filter(t => t.role === 'user');
  if (userMessages.length < MIN_DATA_POINTS) return patterns;

  // ── 1. Daily Activity Volume Trend ──────────────────────────────────────
  if (chatActivity && chatActivity.length >= 5) {
    const dailyCounts = chatActivity.map(c => parseInt(c.user_count) || 0);
    const avg = mean(dailyCounts);
    const sd = stdDev(dailyCounts);

    // Detect if today/yesterday is anomalous
    if (chatActivity.length >= 2 && avg > 0) {
      const todayCount = dailyCounts[0] || 0;
      const yesterdayCount = dailyCounts[1] || 0;

      // Spike detection (z-score > 2)
      const todayZ = sd > 0 ? (todayCount - avg) / sd : 0;
      if (todayZ > 2 && todayCount >= 5) {
        patterns.push({
          pattern_type: 'trend',
          name: '📈 Activity Spike Today',
          description: 'Unusually high activity today (' + todayCount + ' messages vs ~' + Math.round(avg) + ' avg)',
          confidence: Math.min(0.9, todayZ / 3),
          data: { today: todayCount, average: Math.round(avg), z_score: Math.round(todayZ * 100) / 100 },
        });
      }

      // Dip detection
      if (todayZ < -1.5 && avg >= 3) {
        patterns.push({
          pattern_type: 'trend',
          name: '📉 Quiet Day Today',
          description: 'Lower activity than usual today (' + todayCount + ' messages vs ~' + Math.round(avg) + ' avg)',
          confidence: Math.min(0.8, Math.abs(todayZ) / 2),
          data: { today: todayCount, average: Math.round(avg), z_score: Math.round(todayZ * 100) / 100 },
        });
      }
    }

    // ── Weekly pattern: is there a consistent weekday pattern? ────────────
    if (lookbackDays >= 14 && dailyCounts.length >= 10) {
      const firstHalf = dailyCounts.slice(Math.floor(dailyCounts.length / 2));
      const secondHalf = dailyCounts.slice(0, Math.floor(dailyCounts.length / 2));
      const firstAvg = mean(firstHalf);
      const secondAvg = mean(secondHalf);

      if (firstAvg > 0 && secondAvg > 0) {
        const change = (secondAvg - firstAvg) / firstAvg;
        if (Math.abs(change) > 0.3) {
          const direction = change > 0 ? 'increasing' : 'decreasing';
          const pct = Math.round(Math.abs(change) * 100);
          patterns.push({
            pattern_type: 'trend',
            name: (change > 0 ? '📈' : '📉') + ' Engagement ' + (change > 0 ? 'Growing' : 'Declining'),
            description: 'Your activity has been ' + direction + ' (recent avg: ' + Math.round(secondAvg) +
              ' vs earlier: ' + Math.round(firstAvg) + ' msgs/day, ' + pct + '% change)',
            confidence: Math.min(0.85, Math.abs(change)),
            data: { earlier_avg: Math.round(firstAvg), recent_avg: Math.round(secondAvg), change_pct: pct, direction },
          });
        }
      }
    }
  }

  // ── 2. Reminder Completion/Adherence Patterns ───────────────────────────
  if (reminders && reminders.length >= 5) {
    const sent = reminders.filter(r => r.status === 'sent').length;
    const pending = reminders.filter(r => r.status === 'pending').length;
    const total = reminders.length;

    if (total > 0) {
      const adherenceRate = sent / total;
      if (adherenceRate >= 0.8) {
        patterns.push({
          pattern_type: 'trend',
          name: 'High Reminder Adherence',
          description: Math.round(adherenceRate * 100) + '% of past reminders were acknowledged — you\'re on top of things',
          confidence: Math.min(0.75, adherenceRate),
          data: { sent, total, rate: Math.round(adherenceRate * 100) / 100 },
        });
      }
    }
  }

  // ── 3. Task Velocity (tasks created vs completed) ──────────────────────
  if (tasks && tasks.length >= 5) {
    const created = tasks.length;
    const completed = tasks.filter(t => t.status === 'done').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;

    if (created > 0) {
      const velocity = completed / created;
      if (velocity < 0.3 && inProgress > 3) {
        patterns.push({
          pattern_type: 'trend',
          name: '⚠️ Task Backlog Building',
          description: inProgress + ' tasks in progress but only ' + Math.round(velocity * 100) + '% completion rate — time to focus?',
          confidence: 0.7,
          data: { created, completed, in_progress: inProgress, velocity: Math.round(velocity * 100) / 100 },
        });
      }
    }
  }

  // ── 4. Feature Adoption ────────────────────────────────────────────────
  const recentMsgs = userMessages.slice(-Math.min(20, userMessages.length));
  const olderMsgs = userMessages.slice(0, Math.max(0, userMessages.length - 20));

  const recentTools = new Set(recentMsgs.filter(m => m.tool_used).map(m => m.tool_used));
  const olderTools = new Set(olderMsgs.filter(m => m.tool_used).map(m => m.tool_used));

  // Find newly adopted tools
  const newTools = [...recentTools].filter(t => !olderTools.has(t));
  if (newTools.length > 0) {
    const toolLabels = newTools.map(t => t.replace(/_/g, ' '));
    patterns.push({
      pattern_type: 'trend',
      name: '🆕 New Feature: ' + toolLabels.join(', '),
      description: 'You recently started using: ' + toolLabels.join(', '),
      confidence: 0.6,
      data: { new_tools: newTools },
    });
  }

  // ── 5. Time-Topic Correlation ──────────────────────────────────────────
  const correlationPatterns = detectTimeTopicCorrelation(userMessages);
  patterns.push(...correlationPatterns);

  return patterns;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detect if certain topics are discussed more at specific times of day.
 * e.g. "work" mentioned more in mornings, "entertainment" in evenings.
 */
function detectTimeTopicCorrelation(userMessages) {
  const patterns = [];
  if (userMessages.length < 10) return patterns;

  // Simple time buckets
  const MORNING = [5, 6, 7, 8, 9, 10, 11];
  const AFTERNOON = [12, 13, 14, 15, 16];
  const EVENING = [17, 18, 19, 20, 21];
  const NIGHT = [22, 23, 0, 1, 2, 3, 4];

  // Topic indicators (simple keyword-based)
  const topicIndicators = {
    work: ['work', 'kerja', 'meeting', 'mesyuarat', 'task', 'tugas', 'project', 'projek', 'deadline', 'boss', 'office', 'pejabat'],
    health: ['exercise', 'senaman', 'gym', 'workout', 'run', 'lari', 'walk', 'jalan', 'diet', 'makanan', 'sleep', 'tidur'],
    entertainment: ['movie', 'filem', 'watch', 'tonton', 'game', 'main', 'netflix', 'youtube', 'music', 'lagu', 'play'],
    planning: ['plan', 'rancang', 'schedule', 'jadual', 'tomorrow', 'esok', 'next', 'seterusnya', 'goal', 'matlamat'],
    reflection: ['think', 'fikir', 'feel', 'rasa', 'mood', 'reflect', 'today', 'hari_ini', 'done', 'sudah'],
  };

  // Count topic mentions per time bucket
  const timeBuckets = { morning: MORNING, afternoon: AFTERNOON, evening: EVENING, night: NIGHT };
  const topicTimeCounts = {};

  for (const [topic, keywords] of Object.entries(topicIndicators)) {
    topicTimeCounts[topic] = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const msg of userMessages) {
      const hour = new Date(msg.created_at).getHours();
      const content = (msg.content || '').toLowerCase();

      let bucket = 'night';
      if (MORNING.includes(hour)) bucket = 'morning';
      else if (AFTERNOON.includes(hour)) bucket = 'afternoon';
      else if (EVENING.includes(hour)) bucket = 'evening';

      if (keywords.some(kw => content.includes(kw))) {
        topicTimeCounts[topic][bucket]++;
      }
    }
  }

  // Find topics strongly correlated with specific times
  for (const [topic, counts] of Object.entries(topicTimeCounts)) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total < 3) continue;

    for (const [bucket, count] of Object.entries(counts)) {
      const proportion = count / total;
      if (proportion >= 0.5 && count >= 2) {
        const topicLabel = topic.charAt(0).toUpperCase() + topic.slice(1);
        patterns.push({
          pattern_type: 'correlation',
          name: topicLabel + ' → ' + bucket.charAt(0).toUpperCase() + bucket.slice(1),
          description: 'You tend to discuss ' + topicLabel.toLowerCase() + ' topics in the ' + bucket,
          confidence: Math.min(0.75, proportion),
          data: { topic, time_bucket: bucket, proportion: Math.round(proportion * 100) / 100, total_mentions: total },
        });
      }
    }
  }

  return patterns.slice(0, 3); // limit to top 3 correlations
}

module.exports = { detectTrends };
