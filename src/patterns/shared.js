// src/patterns/shared.js
// ── Shared Utilities for Pattern Detectors ───────────────────────────────────
// Extracted to avoid circular dependency between main index and detectors.

const MIN_DATA_POINTS = 3;
const CONFIDENCE_THRESHOLD = 0.5;

/**
 * Calculate the z-score for anomaly detection.
 * Returns how many standard deviations a value is from the mean.
 */
function zScore(value, mean, stdDev) {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

/**
 * Calculate mean of an array of numbers.
 */
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate standard deviation of an array of numbers.
 */
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Calculate a simple moving average over an array.
 */
function movingAverage(arr, window = 3) {
  if (arr.length < window) return arr;
  const result = [];
  for (let i = 0; i <= arr.length - window; i++) {
    result.push(mean(arr.slice(i, i + window)));
  }
  return result;
}

// Common English and Malay stopwords
const STOPWORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
  'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs',
  'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
  'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
  'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'can', 'will', 'just', 'don', 'should', 'now', 'also', 'really',
  // Malay stopwords
  'aku', 'saya', 'kamu', 'awak', 'dia', 'kita', 'kami', 'mereka', 'ini', 'itu',
  'dan', 'di', 'ke', 'dari', 'yang', 'dengan', 'untuk', 'pada', 'adalah',
  'ialah', 'akan', 'telah', 'boleh', 'perlu', 'mesti', 'nak', 'mahu', 'ada',
  'tak', 'tidak', 'bukan', 'pun', 'lah', 'kah', 'nya', 'sangat', 'juga',
  'sudah', 'belum', 'masih', 'selalu', 'kadang', 'sebab', 'kerana', 'macam',
  'bagaimana', 'bila', 'masa', 'apa', 'mana', 'siapa', 'berapa',
  'ya', 'ye', 'ok', 'okay', 'baik', 'tolong', 'bagi', 'buat', 'tahu', 'nak',
  'tu', 'ni', 'dekat', 'kat', 'sini', 'sana', 'situ',
]);

const SIGNIFICANT_KEYWORDS = new Set([
  'remind', 'reminder', 'ingatkan', 'peringatan',
  'event', 'meeting', 'mesyuarat', 'temujanji',
  'task', 'tugas', 'kerja', 'work', 'project', 'projek',
  'goal', 'matlamat', 'target', 'sasaran',
  'note', 'nota', 'catatan', 'idea',
  'sleep', 'tidur', 'wake', 'bangun', 'morning', 'pagi',
  'night', 'malam', 'evening', 'petang',
  'eat', 'makan', 'food', 'lunch', 'dinner', 'breakfast', 'sarapan',
  'exercise', 'gym', 'workout', 'senaman', 'sukan', 'sport',
  'study', 'belajar', 'read', 'baca', 'learn',
  'call', 'telefon', 'phone', 'message', 'text',
  'buy', 'beli', 'shop', 'shopping',
  'travel', 'jalan', 'pergi', 'out', 'keluar',
  'family', 'keluarga', 'mum', 'dad', 'ibu', 'ayah', 'wife', 'husband',
  'friend', 'kawan', 'rakan',
  'health', 'kesihatan', 'sick', 'sakit', 'doctor', 'doktor',
  'money', 'duit', 'finance', 'kewangan', 'budget', 'bajet',
  'code', 'programming', 'coding', 'software', 'app',
  'deadline', 'due', 'tarikh', 'date',
  'schedule', 'jadual', 'calendar', 'kalendar',
]);

/**
 * Extract meaningful keywords from a text, filtering stopwords.
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];

  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  const wordCounts = {};
  for (const w of words) {
    wordCounts[w] = (wordCounts[w] || 0) + 1;
  }

  return Object.entries(wordCounts).map(([word, count]) => ({
    word,
    significance: SIGNIFICANT_KEYWORDS.has(word) ? 2.0 : 1.0,
    count,
  }));
}

module.exports = {
  MIN_DATA_POINTS,
  CONFIDENCE_THRESHOLD,
  zScore,
  mean,
  stdDev,
  movingAverage,
  extractKeywords,
  STOPWORDS,
  SIGNIFICANT_KEYWORDS,
};
