// src/tools/quote.js
// Fetches a random motivational quote from zenquotes.io (free, no API key)
const axios = require('axios');

const FALLBACK_QUOTES = [
  '✨ "The secret of getting ahead is getting started." — Mark Twain',
  '🚀 "It does not matter how slowly you go as long as you do not stop." — Confucius',
  '💪 "Believe you can and you\'re halfway there." — Theodore Roosevelt',
  '🌟 "Your future is created by what you do today, not tomorrow." — Robert Kiyosaki',
  '🔥 "Small daily improvements over time lead to stunning results." — Robin Sharma',
];

/**
 * Fetch a random motivational quote. Falls back to static quotes on error.
 * @returns {Promise<string>}
 */
async function getQuote() {
  try {
    const { data } = await axios.get('https://zenquotes.io/api/random', { timeout: 4000 });
    if (Array.isArray(data) && data.length > 0 && data[0].q) {
      const quote = data[0].q;
      const author = data[0].a;
      return '✨ "' + quote + '" — ' + author;
    }
    throw new Error('Empty response');
  } catch (err) {
    // Zenquotes is a free API and occasionally down — fall back to built-in quotes
    if (!err.message.includes('timeout')) {
      console.warn('⚠️  Quote fetch failed:', err.message);
    }
    const idx = Math.floor(Math.random() * FALLBACK_QUOTES.length);
    return FALLBACK_QUOTES[idx];
  }
}

module.exports = { getQuote };
