// src/tools/weather.js
// Fetches current weather from OpenWeatherMap (free tier)
const axios = require('axios');
const db = require('../db');

const API_KEY = process.env.WEATHER_API_KEY;

/**
 * Fetch current weather summary. Returns null if not configured or on error.
 * Reads WEATHER_LOCATION from DB first, falls back to .env.
 * @returns {Promise<string|null>} e.g. "☀️ Clear sky, 32°C in Kuala Lumpur"
 */
async function getWeatherSummary() {
  const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);
  const LOCATION = await db.getConfig(OWNER_ID, 'weather_location', 'WEATHER_LOCATION');

  if (!API_KEY || !LOCATION) return null;

  try {
    const url = 'https://api.openweathermap.org/data/2.5/weather';
    const { data } = await axios.get(url, {
      params: {
        q: LOCATION,
        appid: API_KEY,
        units: 'metric',
      },
      timeout: 8000,
    });

    const desc = data.weather[0].description;
    const temp = Math.round(data.main.temp);
    const icon = getWeatherEmoji(data.weather[0].id);
    const city = data.name;

    return icon + ' ' + desc + ', ' + temp + '°C in ' + city;
  } catch (err) {
    console.warn('⚠️  Weather fetch failed:', err.message);
    return null;
  }
}

/**
 * Map OpenWeatherMap condition codes to emojis.
 */
function getWeatherEmoji(code) {
  if (code >= 200 && code < 300) return '⛈️';
  if (code >= 300 && code < 400) return '🌧️';
  if (code >= 500 && code < 600) return '🌧️';
  if (code >= 600 && code < 700) return '❄️';
  if (code >= 700 && code < 800) return '🌫️';
  if (code === 800) return '☀️';
  if (code === 801) return '🌤️';
  return '☁️';
}

module.exports = { getWeatherSummary };
