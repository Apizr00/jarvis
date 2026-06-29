// src/patterns/detectors/usage.js
// ── Usage Pattern Detector ───────────────────────────────────────────────────
// Detects patterns related to WHEN the user interacts with the bot:
//   - Peak activity hours (hour-of-day distribution)
//   - Peak activity days (day-of-week distribution)
//   - Session patterns (bursts of activity, idle periods)
//   - Message length trends

const { mean, stdDev, zScore, MIN_DATA_POINTS } = require('../shared');

/**
 * Detect usage/temporal patterns from tracking data.
 * @param {string} userId
 * @param {object} dataContext
 * @param {Array} dataContext.trackingData - raw tracking entries
 * @param {Array} dataContext.chatActivity - daily activity summary
 * @param {number} dataContext.lookbackDays
 * @returns {Promise<Array>} detected patterns
 */
async function detectUsagePatterns(userId, dataContext) {
  const { trackingData, chatActivity, lookbackDays } = dataContext;
  const patterns = [];

  if (!trackingData || trackingData.length < MIN_DATA_POINTS) {
    return patterns;
  }

  // ── Filter to user messages only ────────────────────────────────────────
  const userMessages = trackingData.filter(t => t.role === 'user');
  if (userMessages.length < MIN_DATA_POINTS) return patterns;

  // ── 1. Hour-of-Day Distribution ────────────────────────────────────────
  const hourCounts = new Array(24).fill(0);
  for (const msg of userMessages) {
    const hour = new Date(msg.created_at).getHours();
    hourCounts[hour]++;
  }

  // Find peak hours (hours with count > mean + 1 std dev)
  const hourValues = hourCounts.filter(c => c > 0);
  const hourMean = mean(hourValues);
  const hourStd = stdDev(hourValues);
  const peakThreshold = hourMean + hourStd;

  const peakHours = [];
  for (let h = 0; h < 24; h++) {
    if (hourCounts[h] >= peakThreshold && hourCounts[h] > 0) {
      peakHours.push(h);
    }
  }

  if (peakHours.length > 0) {
    // Group consecutive hours into ranges
    const ranges = groupConsecutiveHours(peakHours);

    for (const range of ranges) {
      const avgCount = mean(range.hours.map(h => hourCounts[h]));
      const totalInRange = range.hours.reduce((sum, h) => sum + hourCounts[h], 0);
      const proportion = totalInRange / userMessages.length;

      patterns.push({
        pattern_type: 'usage',
        name: 'Peak Activity: ' + formatHourRange(range.hours),
        description: 'Most active during ' + formatHourRangeDesc(range.hours) +
          ' (' + Math.round(proportion * 100) + '% of messages)',
        confidence: Math.min(0.95, proportion * 1.5),
        data: {
          hours: range.hours,
          counts: range.hours.map(h => hourCounts[h]),
          proportion: Math.round(proportion * 100) / 100,
          total_messages: userMessages.length,
        },
      });
    }
  }

  // ── 2. Day-of-Week Distribution ────────────────────────────────────────
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayCounts = new Array(7).fill(0);
  for (const msg of userMessages) {
    const day = new Date(msg.created_at).getDay();
    dayCounts[day]++;
  }

  const dayValues = dayCounts.filter(c => c > 0);
  const dayMean = mean(dayValues);
  const dayStd = stdDev(dayValues);
  const dayThreshold = dayMean + dayStd * 0.5; // more sensitive for days (fewer buckets)

  const peakDays = [];
  const lowDays = [];
  for (let d = 0; d < 7; d++) {
    if (dayCounts[d] >= dayThreshold && dayCounts[d] > 0) peakDays.push(d);
    if (dayCounts[d] === 0) lowDays.push(d);
  }

  if (peakDays.length > 0 && peakDays.length < 7) {
    const dayLabels = peakDays.map(d => dayNames[d]);
    const totalPeak = peakDays.reduce((sum, d) => sum + dayCounts[d], 0);
    const proportion = totalPeak / userMessages.length;

    patterns.push({
      pattern_type: 'usage',
      name: 'Preferred Days: ' + dayLabels.join(', '),
      description: 'Most active on ' + dayLabels.join(', ') +
        ' (' + Math.round(proportion * 100) + '% of activity)',
      confidence: Math.min(0.9, proportion),
      data: {
        days: peakDays,
        day_labels: dayLabels,
        counts: peakDays.map(d => dayCounts[d]),
        proportion: Math.round(proportion * 100) / 100,
      },
    });
  }

  // Detect weekend vs weekday pattern
  const weekdayTotal = dayCounts[1] + dayCounts[2] + dayCounts[3] + dayCounts[4] + dayCounts[5];
  const weekendTotal = dayCounts[0] + dayCounts[6];
  const total = weekdayTotal + weekendTotal;

  if (total > 0) {
    const weekdayRatio = weekdayTotal / total;
    if (weekdayRatio > 0.8) {
      patterns.push({
        pattern_type: 'usage',
        name: 'Weekday-heavy User',
        description: 'Strongly prefers weekday interactions (' + Math.round(weekdayRatio * 100) + '% on weekdays)',
        confidence: Math.min(0.85, weekdayRatio),
        data: { weekday_ratio: Math.round(weekdayRatio * 100) / 100 },
      });
    } else if (weekdayRatio < 0.4) {
      patterns.push({
        pattern_type: 'usage',
        name: 'Weekend-heavy User',
        description: 'More active on weekends (' + Math.round((1 - weekdayRatio) * 100) + '% on weekends)',
        confidence: Math.min(0.85, 1 - weekdayRatio),
        data: { weekday_ratio: Math.round(weekdayRatio * 100) / 100 },
      });
    }
  }

  // ── 3. Activity Consistency ────────────────────────────────────────────
  if (chatActivity && chatActivity.length >= 3) {
    const dailyCounts = chatActivity.map(c => parseInt(c.user_count) || 0);
    const avgDaily = mean(dailyCounts);
    const stdDaily = stdDev(dailyCounts);

    if (avgDaily > 0) {
      // Calculate coefficient of variation (std/mean) — lower = more consistent
      const cv = stdDaily / avgDaily;

      if (cv < 0.3 && avgDaily >= 2) {
        patterns.push({
          pattern_type: 'usage',
          name: 'Very Consistent Usage',
          description: 'Remarkably consistent daily usage (~' + Math.round(avgDaily) + ' msgs/day, minimal variation)',
          confidence: Math.min(0.9, 1 - cv),
          data: { avg_daily: Math.round(avgDaily), cv: Math.round(cv * 100) / 100 },
        });
      } else if (cv > 1.0 && avgDaily >= 1) {
        patterns.push({
          pattern_type: 'usage',
          name: 'Bursty Usage Pattern',
          description: 'Usage comes in bursts — some days very active, others quiet',
          confidence: Math.min(0.85, cv / 2),
          data: { avg_daily: Math.round(avgDaily), cv: Math.round(cv * 100) / 100 },
        });
      }
    }

    // ── 4. Activity Trend (increasing/decreasing) ────────────────────────
    if (dailyCounts.length >= 5) {
      const trend = detectTrend(dailyCounts);
      if (trend && trend.confidence >= 0.6) {
        patterns.push({
          pattern_type: 'usage',
          name: trend.increasing ? '📈 Increasing Activity' : '📉 Decreasing Activity',
          description: trend.increasing
            ? 'Your usage has been trending upward recently'
            : 'Your usage has been trending downward recently',
          confidence: trend.confidence,
          data: { slope: Math.round(trend.slope * 1000) / 1000, direction: trend.increasing ? 'up' : 'down' },
        });
      }
    }
  }

  // ── 5. Low-activity days (potential oversight alert) ───────────────────
  if (lowDays.length >= 2 && lookbackDays >= 7) {
    const lowLabels = lowDays.map(d => dayNames[d]);
    patterns.push({
      pattern_type: 'usage',
      name: 'Quiet Days: ' + lowLabels.join(', '),
      description: 'No activity detected on ' + lowLabels.join(', ') + ' during the lookback period',
      confidence: 0.5,
      data: { days: lowDays, day_labels: lowLabels },
    });
  }

  return patterns;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Group consecutive hours into ranges.
 * e.g. [6, 7, 8, 12, 13] → [[6, 7, 8], [12, 13]]
 */
function groupConsecutiveHours(hours) {
  if (hours.length === 0) return [];
  const sorted = [...hours].sort((a, b) => a - b);
  const ranges = [];
  let current = { hours: [sorted[0]] };

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === current.hours[current.hours.length - 1] + 1) {
      current.hours.push(sorted[i]);
    } else {
      ranges.push(current);
      current = { hours: [sorted[i]] };
    }
  }
  ranges.push(current);
  return ranges;
}

/**
 * Format hour range for display.
 * e.g. [6, 7, 8] → "6AM-8AM"
 */
function formatHourRange(hours) {
  if (hours.length === 0) return '';
  if (hours.length === 1) return formatHour(hours[0]);

  const sorted = [...hours].sort((a, b) => a - b);
  return formatHour(sorted[0]) + '-' + formatHour(sorted[sorted.length - 1]);
}

function formatHourRangeDesc(hours) {
  if (hours.length === 0) return '';
  if (hours.length === 1) return formatHour(hours[0]);

  const sorted = [...hours].sort((a, b) => a - b);
  const start = formatHour(sorted[0]);
  const end = formatHour(sorted[sorted.length - 1]);

  // Determine time-of-day label
  const mid = sorted[Math.floor(sorted.length / 2)];
  if (mid >= 5 && mid < 12) return 'mornings (' + start + '-' + end + ')';
  if (mid >= 12 && mid < 17) return 'afternoons (' + start + '-' + end + ')';
  if (mid >= 17 && mid < 22) return 'evenings (' + start + '-' + end + ')';
  return 'late nights (' + start + '-' + end + ')';
}

function formatHour(h) {
  if (h === 0) return '12AM';
  if (h === 12) return '12PM';
  if (h < 12) return h + 'AM';
  return (h - 12) + 'PM';
}

/**
 * Simple linear trend detection using basic linear regression on indices.
 * Returns slope direction and confidence based on R² approximation.
 */
function detectTrend(values) {
  const n = values.length;
  if (n < 5) return null;

  const indices = values.map((_, i) => i);
  const xMean = mean(indices);
  const yMean = mean(values);

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (indices[i] - xMean) * (values[i] - yMean);
    denominator += (indices[i] - xMean) ** 2;
  }

  if (denominator === 0) return null;

  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;

  // Calculate R²
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * indices[i] + intercept;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - yMean) ** 2;
  }
  const rSquared = ssTot === 0 ? 0 : 1 - (ssRes / ssTot);

  const increasing = slope > 0;
  // Confidence based on R² and relative slope magnitude
  const relSlope = Math.abs(slope) / (Math.abs(yMean) || 1);
  const confidence = Math.min(0.95, rSquared * 0.6 + relSlope * 0.4);

  if (confidence < 0.4) return null;

  return { slope, intercept, increasing, rSquared, confidence };
}

module.exports = { detectUsagePatterns };
