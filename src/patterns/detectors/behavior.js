// src/patterns/detectors/behavior.js
// ── Behavioral Pattern Detector ──────────────────────────────────────────────
// Detects patterns in HOW the user uses the bot's features:
//   - Reminder creation habits (types, timing, recurrence patterns)
//   - Task management patterns (completion rate, priority distribution)
//   - Note-taking frequency and themes
//   - Tool usage distribution
//   - Goal progress tracking

const { mean, stdDev, MIN_DATA_POINTS } = require('../shared');

/**
 * Detect behavioral patterns from reminders, tasks, goals, and tool usage.
 * @param {string} userId
 * @param {object} dataContext
 * @returns {Promise<Array>}
 */
async function detectBehaviorPatterns(userId, dataContext) {
  const { reminders, tasks, goals, notes, trackingData, lookbackDays } = dataContext;
  const patterns = [];

  // ── 1. Reminder Patterns ────────────────────────────────────────────────
  if (reminders && reminders.length >= MIN_DATA_POINTS) {
    // Reminder category distribution
    const categories = categorizeReminders(reminders);
    const totalReminders = reminders.length;

    for (const [category, count] of Object.entries(categories)) {
      const proportion = count / totalReminders;
      if (proportion >= 0.25) {
        patterns.push({
          pattern_type: 'behavior',
          name: 'Reminder Focus: ' + category,
          description: Math.round(proportion * 100) + '% of your reminders are about ' + category.toLowerCase(),
          confidence: Math.min(0.85, proportion * 1.5),
          data: { category, count, proportion: Math.round(proportion * 100) / 100, total_reminders: totalReminders },
        });
      }
    }

    // Recurring reminder usage
    const recurringCount = reminders.filter(r => r.recurrence).length;
    const recurringRatio = recurringCount / totalReminders;
    if (recurringRatio >= 0.3) {
      patterns.push({
        pattern_type: 'behavior',
        name: 'Routine Builder',
        description: Math.round(recurringRatio * 100) + '% of your reminders recur — you like building habits',
        confidence: Math.min(0.8, recurringRatio),
        data: { recurring_count: recurringCount, ratio: Math.round(recurringRatio * 100) / 100 },
      });
    }

    // Reminder time-of-day clustering
    const reminderHours = reminders.map(r => new Date(r.remind_at).getHours());
    const hourClusters = findHourClusters(reminderHours);
    if (hourClusters.length > 0) {
      for (const cluster of hourClusters) {
        const clusterRatio = cluster.count / totalReminders;
        if (clusterRatio >= 0.3) {
          const label = hourToLabel(cluster.hour);
          patterns.push({
            pattern_type: 'behavior',
            name: 'Reminder Time: ' + label,
            description: Math.round(clusterRatio * 100) + '% of your reminders cluster around ' + label.toLowerCase(),
            confidence: Math.min(0.8, clusterRatio),
            data: { hour: cluster.hour, count: cluster.count, ratio: Math.round(clusterRatio * 100) / 100 },
          });
        }
      }
    }
  }

  // ── 2. Task Management Patterns ─────────────────────────────────────────
  if (tasks && tasks.length >= MIN_DATA_POINTS) {
    // Completion rate
    const done = tasks.filter(t => t.status === 'done').length;
    const cancelled = tasks.filter(t => t.status === 'cancelled').length;
    const total = tasks.length;
    const completionRate = done / total;

    if (completionRate >= 0.7 && total >= 5) {
      patterns.push({
        pattern_type: 'behavior',
        name: 'Task Champion 🏆',
        description: 'You complete ' + Math.round(completionRate * 100) + '% of your tasks — impressive follow-through!',
        confidence: Math.min(0.9, completionRate),
        data: { completed: done, total, rate: Math.round(completionRate * 100) / 100 },
      });
    } else if (completionRate < 0.3 && total >= 5) {
      patterns.push({
        pattern_type: 'behavior',
        name: 'Task Collector',
        description: 'You create many tasks but complete only ' + Math.round(completionRate * 100) + '% — consider smaller steps',
        confidence: Math.min(0.8, 1 - completionRate),
        data: { completed: done, total, rate: Math.round(completionRate * 100) / 100 },
      });
    }

    // Priority distribution
    const highPriority = tasks.filter(t => t.priority === 'high').length;
    const highRatio = highPriority / total;
    if (highRatio >= 0.5 && total >= 4) {
      patterns.push({
        pattern_type: 'behavior',
        name: 'High-Priority Focus',
        description: Math.round(highRatio * 100) + '% of your tasks are high priority — you focus on what matters',
        confidence: Math.min(0.75, highRatio),
        data: { high_count: highPriority, ratio: Math.round(highRatio * 100) / 100 },
      });
    }
  }

  // ── 3. Note-Taking Patterns ─────────────────────────────────────────────
  if (notes && notes.length >= MIN_DATA_POINTS) {
    // Calculate average notes per day
    const notesPerDay = notes.length / Math.max(lookbackDays, 1);
    if (notesPerDay >= 2) {
      patterns.push({
        pattern_type: 'behavior',
        name: 'Avid Note-Taker 📝',
        description: 'You save ~' + Math.round(notesPerDay) + ' notes per day — great for capturing ideas',
        confidence: Math.min(0.8, notesPerDay / 5),
        data: { total_notes: notes.length, per_day: Math.round(notesPerDay * 10) / 10, lookback_days: lookbackDays },
      });
    }

    // Note content clustering
    const noteKeywords = {};
    for (const note of notes.slice(0, 50)) {
      const words = (note.content || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
      for (const w of words) {
        noteKeywords[w] = (noteKeywords[w] || 0) + 1;
      }
    }
    const topNoteWords = Object.entries(noteKeywords)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);
    if (topNoteWords.length >= 3) {
      patterns.push({
        pattern_type: 'behavior',
        name: 'Note Themes: ' + topNoteWords.slice(0, 3).join(', '),
        description: 'Your notes frequently mention: ' + topNoteWords.join(', '),
        confidence: 0.55,
        data: { top_words: topNoteWords },
      });
    }
  }

  // ── 4. Goal Patterns ────────────────────────────────────────────────────
  if (goals && goals.length > 0) {
    const active = goals.filter(g => g.status === 'active');
    const completed = goals.filter(g => g.status === 'completed');
    const abandoned = goals.filter(g => g.status === 'abandoned');

    if (active.length >= 3) {
      patterns.push({
        pattern_type: 'behavior',
        name: 'Multi-Goal Juggler',
        description: 'You\'re actively pursuing ' + active.length + ' goals simultaneously — ambitious!',
        confidence: Math.min(0.7, active.length / 5),
        data: { active: active.length, completed: completed.length, abandoned: abandoned.length },
      });
    }

    const goalCompletionRate = goals.length > 0 ? completed.length / goals.length : 0;
    if (goalCompletionRate >= 0.5 && goals.length >= 3) {
      patterns.push({
        pattern_type: 'behavior',
        name: 'Goal Achiever 🎯',
        description: 'You\'ve completed ' + Math.round(goalCompletionRate * 100) + '% of your goals — stay focused!',
        confidence: Math.min(0.85, goalCompletionRate),
        data: { completed: completed.length, total: goals.length, rate: Math.round(goalCompletionRate * 100) / 100 },
      });
    }
  }

  // ── 5. Tool Usage Distribution ──────────────────────────────────────────
  if (trackingData && trackingData.length >= MIN_DATA_POINTS) {
    const toolCounts = {};
    let toolMessages = 0;
    for (const entry of trackingData) {
      if (entry.tool_used) {
        toolCounts[entry.tool_used] = (toolCounts[entry.tool_used] || 0) + 1;
        toolMessages++;
      }
    }

    if (toolMessages >= 5) {
      const sortedTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
      const topTool = sortedTools[0];
      if (topTool && topTool[1] / toolMessages >= 0.4) {
        const toolLabel = topTool[0].replace(/_/g, ' ');
        patterns.push({
          pattern_type: 'behavior',
          name: 'Favorite Feature: ' + toolLabel,
          description: 'You use ' + toolLabel + ' most often (' + Math.round(topTool[1] / toolMessages * 100) + '% of tool interactions)',
          confidence: Math.min(0.8, topTool[1] / toolMessages),
          data: { tool: topTool[0], count: topTool[1], ratio: Math.round(topTool[1] / toolMessages * 100) / 100 },
        });
      }
    }
  }

  return patterns;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Categorize reminders into broad themes based on text content.
 */
function categorizeReminders(reminders) {
  const categories = {};

  const categoryRules = [
    { name: 'Work & Tasks', keywords: ['work', 'kerja', 'task', 'tugas', 'meeting', 'mesyuarat', 'project', 'projek', 'deadline', 'submit', 'hantar', 'client', 'klien', 'boss', 'office', 'pejabat', 'email', 'report', 'laporan'] },
    { name: 'Health & Wellness', keywords: ['exercise', 'senaman', 'gym', 'workout', 'run', 'lari', 'walk', 'jalan', 'medicine', 'ubat', 'pill', 'vitamin', 'doctor', 'doktor', 'appointment', 'temujanji', 'dr', 'sleep', 'tidur', 'meditate', 'meditasi', 'yoga'] },
    { name: 'Family & Social', keywords: ['call', 'telefon', 'call', 'mum', 'ibu', 'dad', 'ayah', 'wife', 'isteri', 'husband', 'suami', 'child', 'anak', 'family', 'keluarga', 'friend', 'kawan', 'meet', 'jumpa', 'dinner', 'makan_malam', 'lunch', 'birthday', 'hari_jadi'] },
    { name: 'Shopping & Errands', keywords: ['buy', 'beli', 'shop', 'kedai', 'groceries', 'barang', 'pay', 'bayar', 'bill', 'bil', 'bank', 'post', 'pos', 'delivery', 'penghantaran', 'order', 'pesan'] },
    { name: 'Learning & Study', keywords: ['study', 'belajar', 'read', 'baca', 'course', 'kursus', 'class', 'kelas', 'homework', 'kerja_rumah', 'assignment', 'tugasan', 'exam', 'peperiksaan', 'learn', 'practice', 'latihan'] },
    { name: 'Daily Routine', keywords: ['wake', 'bangun', 'sleep', 'tidur', 'eat', 'makan', 'breakfast', 'sarapan', 'lunch', 'dinner', 'shower', 'mandi', 'commute', 'ulang_alik', 'leave', 'keluar', 'home', 'rumah', 'balik'] },
  ];

  for (const reminder of reminders) {
    const text = (reminder.text || '').toLowerCase();
    let matched = false;

    for (const rule of categoryRules) {
      if (rule.keywords.some(kw => text.includes(kw))) {
        categories[rule.name] = (categories[rule.name] || 0) + 1;
        matched = true;
        break; // assign to first matching category
      }
    }

    if (!matched) {
      categories['General'] = (categories['General'] || 0) + 1;
    }
  }

  return categories;
}

/**
 * Find clusters of hours from reminder times.
 * Groups hours that are within 2 hours of each other.
 */
function findHourClusters(hours) {
  if (hours.length < 2) return [];

  const sorted = [...hours].sort((a, b) => a - b);
  const clusters = [];
  let current = { hour: sorted[0], count: 1 };

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - current.hour) <= 2) {
      // Close enough — merge by weighted average
      const totalWeight = current.count + 1;
      current.hour = Math.round((current.hour * current.count + sorted[i]) / totalWeight);
      current.count++;
    } else {
      if (current.count >= 2) clusters.push({ ...current });
      current = { hour: sorted[i], count: 1 };
    }
  }
  if (current.count >= 2) clusters.push({ ...current });

  return clusters.sort((a, b) => b.count - a.count);
}

function hourToLabel(hour) {
  if (hour >= 5 && hour < 12) return 'Morning (' + hour + ':00)';
  if (hour >= 12 && hour < 17) return 'Afternoon (' + hour + ':00)';
  if (hour >= 17 && hour < 22) return 'Evening (' + hour + ':00)';
  return 'Night (' + hour + ':00)';
}

module.exports = { detectBehaviorPatterns };
