// quick test: simulate morning briefing quote fallback
require('dotenv').config();
const { getWeatherSummary } = require('./src/tools/weather');

async function test() {
  const weather = await getWeatherSummary();
  console.log('Weather:', weather || '(null — fallback to quote)');
  console.log('');

  const quotes = [
    '✨ "The secret of getting ahead is getting started." — Mark Twain',
    '🚀 "It does not matter how slowly you go as long as you do not stop." — Confucius',
    '💪 "Believe you can and you\'re halfway there." — Theodore Roosevelt',
    '🌟 "Your future is created by what you do today, not tomorrow." — Robert Kiyosaki',
    '🔥 "Small daily improvements over time lead to stunning results." — Robin Sharma',
  ];
  const quote = quotes[Math.floor(Math.random() * quotes.length)];
  console.log('Quote:', quote);
}
test();
