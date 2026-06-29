// src/patterns/detectors/topics.js
// ── Topic Pattern Detector ───────────────────────────────────────────────────
// Detects patterns in WHAT the user talks about:
//   - Frequently discussed keywords and themes
//   - Topic clusters (co-occurring keywords)
//   - Conversation thread depth
//   - Language mix patterns (English/Malay ratio)

const { mean, stdDev, extractKeywords, MIN_DATA_POINTS } = require('../shared');

// Thematic keyword groups — keywords that belong to the same "theme"
const THEME_GROUPS = {
  work_productivity: ['work', 'kerja', 'project', 'projek', 'task', 'tugas', 'deadline',
    'meeting', 'mesyuarat', 'office', 'pejabat', 'client', 'klien', 'boss',
    'colleague', 'rakan_sekerja', 'productivity', 'produktiviti', 'focus', 'fokus'],
  health_wellness: ['health', 'kesihatan', 'exercise', 'senaman', 'gym', 'workout',
    'diet', 'makanan', 'sleep', 'tidur', 'rest', 'rehat', 'sick', 'sakit',
    'doctor', 'doktor', 'medicine', 'ubat', 'mental', 'stress', 'tekanan',
    'meditation', 'meditasi', 'yoga', 'walk', 'jalan'],
  learning_growth: ['study', 'belajar', 'learn', 'read', 'baca', 'book', 'buku',
    'course', 'kursus', 'class', 'kelas', 'skill', 'kemahiran', 'knowledge',
    'ilmu', 'research', 'kajian', 'think', 'fikir', 'idea', 'idea'],
  social_relationships: ['friend', 'kawan', 'family', 'keluarga', 'mum', 'ibu',
    'dad', 'ayah', 'wife', 'isteri', 'husband', 'suami', 'child', 'anak',
    'parent', 'ibubapa', 'sibling', 'adik_beradik', 'meet', 'jumpa',
    'call', 'telefon', 'chat', 'message'],
  finance_money: ['money', 'duit', 'finance', 'kewangan', 'budget', 'bajet',
    'expense', 'perbelanjaan', 'save', 'simpan', 'invest', 'labur',
    'bill', 'bil', 'pay', 'bayar', 'salary', 'gaji', 'price', 'harga'],
  tech_coding: ['code', 'programming', 'coding', 'software', 'app', 'website',
    'server', 'database', 'api', 'bug', 'debug', 'deploy', 'github',
    'tech', 'teknologi', 'computer', 'komputer', 'AI', 'bot',
    'developer', 'pembangun'],
  daily_routine: ['morning', 'pagi', 'night', 'malam', 'evening', 'petang',
    'wake', 'bangun', 'sleep', 'tidur', 'breakfast', 'sarapan',
    'lunch', 'makan_tengahari', 'dinner', 'makan_malam',
    'commute', 'ulang_alik', 'drive', 'pandu', 'traffic', 'jem'],
  entertainment: ['movie', 'filem', 'watch', 'tonton', 'music', 'lagu',
    'game', 'permainan', 'play', 'main', 'show', 'rancangan',
    'netflix', 'youtube', 'podcast', 'book', 'buku', 'novel'],
  goals_planning: ['goal', 'matlamat', 'plan', 'rancang', 'target', 'sasaran',
    'future', 'masa_depan', 'dream', 'impian', 'achieve', 'capai',
    'progress', 'kemajuan', 'milestone', 'pencapaian'],
};

/**
 * Detect topic/content patterns from conversation data.
 * @param {string} userId
 * @param {object} dataContext
 * @returns {Promise<Array>}
 */
async function detectTopicPatterns(userId, dataContext) {
  const { trackingData, lookbackDays } = dataContext;
  const patterns = [];

  const userMessages = (trackingData || []).filter(t => t.role === 'user');
  if (userMessages.length < MIN_DATA_POINTS) return patterns;

  // ── 1. Aggregate keyword frequencies ───────────────────────────────────
  const keywordFreq = {};
  let totalKeywords = 0;

  for (const msg of userMessages) {
    let keywords;
    if (msg.keywords && Array.isArray(msg.keywords)) {
      keywords = msg.keywords;
    } else if (msg.content) {
      keywords = extractKeywords(msg.content);
    } else {
      continue;
    }

    for (const kw of keywords) {
      const word = typeof kw === 'string' ? kw : kw.word;
      const sig = typeof kw === 'object' ? (kw.significance || 1) : 1;
      keywordFreq[word] = (keywordFreq[word] || 0) + sig;
      totalKeywords++;
    }
  }

  if (totalKeywords < MIN_DATA_POINTS) return patterns;

  // ── 2. Top keywords (frequency-based) ──────────────────────────────────
  const sortedKeywords = Object.entries(keywordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const freqValues = sortedKeywords.map(([, v]) => v);
  const freqMean = mean(freqValues);
  const freqStd = stdDev(freqValues);

  const topKeywords = sortedKeywords.filter(([, v]) => v >= freqMean + freqStd * 0.5);
  if (topKeywords.length >= 2) {
    const topWords = topKeywords.map(([w]) => '#' + w).join(', ');
    patterns.push({
      pattern_type: 'topic',
      name: 'Top Keywords: ' + topKeywords.slice(0, 5).map(([w]) => w).join(', '),
      description: 'Most frequent topics: ' + topWords,
      confidence: Math.min(0.85, topKeywords.length / 5),
      data: {
        keywords: topKeywords.map(([w, c]) => ({ word: w, count: c })),
        total_keywords: totalKeywords,
      },
    });
  }

  // ── 3. Theme detection ─────────────────────────────────────────────────
  const themeScores = {};
  for (const [theme, themeWords] of Object.entries(THEME_GROUPS)) {
    let score = 0;
    let matches = 0;
    for (const word of themeWords) {
      if (keywordFreq[word]) {
        score += keywordFreq[word];
        matches++;
      }
    }
    if (matches >= 2) {
      themeScores[theme] = { score, matches, proportion: score / Math.max(totalKeywords, 1) };
    }
  }

  // Report top themes
  const sortedThemes = Object.entries(themeScores)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3);

  for (const [theme, info] of sortedThemes) {
    if (info.matches >= 2) {
      const themeLabel = theme.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const pct = Math.round(info.proportion * 100);
      patterns.push({
        pattern_type: 'topic',
        name: 'Theme: ' + themeLabel,
        description: '~' + pct + '% of your conversations relate to ' + themeLabel.toLowerCase(),
        confidence: Math.min(0.85, info.proportion * 5),
        data: { theme, matches: info.matches, proportion: Math.round(info.proportion * 100) / 100 },
      });
    }
  }

  // ── 4. Keyword co-occurrence clusters ──────────────────────────────────
  const cooccurrenceClusters = findCooccurrenceClusters(userMessages);
  if (cooccurrenceClusters.length > 0) {
    for (const cluster of cooccurrenceClusters.slice(0, 2)) {
      patterns.push({
        pattern_type: 'topic',
        name: 'Linked Topics: ' + cluster.words.join(' + '),
        description: 'These topics often appear together: ' + cluster.words.join(', '),
        confidence: Math.min(0.8, cluster.strength),
        data: { words: cluster.words, cooccurrences: cluster.count, strength: cluster.strength },
      });
    }
  }

  // ── 5. Language mix detection (English vs Malay) ───────────────────────
  const langPattern = detectLanguageMix(userMessages);
  if (langPattern) {
    patterns.push(langPattern);
  }

  // ── 6. Message complexity (avg length trend) ───────────────────────────
  const avgLengths = [];
  const lengths = userMessages.map(m => (m.content || '').length);
  const avgLen = mean(lengths);

  if (avgLen > 100) {
    patterns.push({
      pattern_type: 'topic',
      name: 'Detailed Communicator',
      description: 'You tend to write longer, detailed messages (avg ' + Math.round(avgLen) + ' chars)',
      confidence: 0.6,
      data: { avg_message_length: Math.round(avgLen) },
    });
  } else if (avgLen < 30 && userMessages.length >= 5) {
    patterns.push({
      pattern_type: 'topic',
      name: 'Concise Communicator',
      description: 'You prefer short, direct messages (avg ' + Math.round(avgLen) + ' chars)',
      confidence: 0.6,
      data: { avg_message_length: Math.round(avgLen) },
    });
  }

  return patterns;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find pairs of keywords that frequently appear together in the same message.
 * Uses a simple co-occurrence matrix approach.
 */
function findCooccurrenceClusters(userMessages) {
  // Extract keyword sets per message
  const msgKeywords = [];
  for (const msg of userMessages) {
    let kws;
    if (msg.keywords && Array.isArray(msg.keywords)) {
      kws = msg.keywords.map(k => typeof k === 'string' ? k : k.word);
    } else if (msg.content) {
      kws = extractKeywords(msg.content).map(k => k.word);
    } else {
      continue;
    }
    // Deduplicate
    const unique = [...new Set(kws)];
    if (unique.length >= 2) msgKeywords.push(unique);
  }

  if (msgKeywords.length < 3) return [];

  // Count co-occurrences
  const cooccurrences = {};
  for (const kws of msgKeywords) {
    for (let i = 0; i < kws.length; i++) {
      for (let j = i + 1; j < kws.length; j++) {
        const pair = [kws[i], kws[j]].sort().join('|||');
        cooccurrences[pair] = (cooccurrences[pair] || 0) + 1;
      }
    }
  }

  // Filter significant co-occurrences (appear in at least 10% of messages with enough keywords)
  const threshold = Math.max(2, Math.floor(msgKeywords.length * 0.1));
  const clusters = Object.entries(cooccurrences)
    .filter(([, count]) => count >= threshold)
    .map(([pair, count]) => ({
      words: pair.split('|||'),
      count,
      strength: Math.min(1, count / msgKeywords.length),
    }))
    .sort((a, b) => b.strength - a.strength);

  // Merge overlapping clusters
  return mergeClusters(clusters).slice(0, 3);
}

/**
 * Very simple cluster merging — if two clusters share a word, merge them.
 */
function mergeClusters(clusters) {
  if (clusters.length <= 1) return clusters;

  const merged = [];
  const used = new Set();

  for (let i = 0; i < clusters.length; i++) {
    if (used.has(i)) continue;
    const current = { words: [...clusters[i].words], count: clusters[i].count, strength: clusters[i].strength };
    used.add(i);

    for (let j = i + 1; j < clusters.length; j++) {
      if (used.has(j)) continue;
      if (clusters[j].words.some(w => current.words.includes(w))) {
        for (const w of clusters[j].words) {
          if (!current.words.includes(w)) current.words.push(w);
        }
        current.count += clusters[j].count;
        current.strength = Math.max(current.strength, clusters[j].strength);
        used.add(j);
      }
    }

    if (current.words.length >= 2) merged.push(current);
  }

  return merged.sort((a, b) => b.strength - a.strength);
}

/**
 * Detect the user's language mix (English vs Malay).
 */
function detectLanguageMix(userMessages) {
  // Simple heuristic: count Malay vs English words
  const malayMarkers = ['saya', 'aku', 'nak', 'tak', 'tu', 'ni', 'dengan', 'untuk',
    'pada', 'adalah', 'ialah', 'boleh', 'perlu', 'mahu', 'pun', 'lah', 'kah',
    'sebab', 'kerana', 'macam', 'bagi', 'buat', 'tahu', 'dekat', 'kat',
    'sini', 'sana', 'situ', 'ingatkan', 'peringatan', 'kerja', 'makan'];

  let malayWordCount = 0;
  let totalWordCount = 0;

  for (const msg of userMessages) {
    const content = (msg.content || '').toLowerCase();
    const words = content.split(/\s+/).filter(w => w.length > 1);
    totalWordCount += words.length;

    for (const word of words) {
      if (malayMarkers.includes(word)) malayWordCount++;
    }
  }

  if (totalWordCount < 20) return null;

  const malayRatio = malayWordCount / totalWordCount;

  if (malayRatio > 0.15) {
    return {
      pattern_type: 'topic',
      name: 'Bilingual: EN + BM',
      description: 'You mix English and Bahasa Melayu (~' + Math.round(malayRatio * 100) + '% Malay words)',
      confidence: Math.min(0.85, malayRatio * 2),
      data: { malay_ratio: Math.round(malayRatio * 100) / 100 },
    };
  } else if (malayRatio > 0.05) {
    return {
      pattern_type: 'topic',
      name: 'Primarily English with some BM',
      description: 'Mostly English with occasional Bahasa Melayu (~' + Math.round(malayRatio * 100) + '% Malay words)',
      confidence: 0.5,
      data: { malay_ratio: Math.round(malayRatio * 100) / 100 },
    };
  }

  return null;
}

module.exports = { detectTopicPatterns };
