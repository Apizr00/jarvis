// src/llm/whisper.js
// OpenAI Whisper API — transcribes voice messages to text
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Transcribe an audio file using OpenAI's Whisper API.
 * Uses Node.js 18+ built-in fetch + FormData for reliable multipart upload.
 * @param {string} filePath - Path to the audio file (ogg/mp3/wav)
 * @param {'telegram_bot'|'user'} sentBy - Who sent the voice message
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribe(filePath, sentBy = 'telegram_bot') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set. Voice transcription requires an OpenAI API key.');
  }

  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = fileName.endsWith('.mp3') ? 'audio/mpeg'
    : fileName.endsWith('.wav') ? 'audio/wav'
      : 'audio/ogg'; // Telegram voice notes are OGG/Opus

  // Build multipart form data using Node 18+ built-in FormData
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'json');

  // Language: set WHISPER_LANGUAGE in .env to force a specific language (e.g. "ms" or "en").
  // Leave unset for auto-detection — works well for mixed Malay + English.
  const lang = process.env.WHISPER_LANGUAGE;
  if (lang && ['en', 'ms', 'zh', 'ja', 'ko', 'ar', 'id', 'th', 'vi', 'hi', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'nl', 'tr', 'pl', 'sv', 'da', 'no', 'fi', 'cs', 'hu', 'ro', 'sk', 'uk', 'el', 'he'].includes(lang.toLowerCase())) {
    formData.append('language', lang.toLowerCase());
  } else if (lang) {
    // Multiple languages requested (e.g. "en,ms") — let Whisper auto-detect
    console.log('[Whisper] Multiple languages requested, using auto-detect:', lang);
  }

  // Prompt: set WHISPER_PROMPT in .env to provide context hints for mixed-language audio.
  // Useful for improving accuracy on proper nouns, code-switching, or domain terms.
  const prompt = process.env.WHISPER_PROMPT;
  if (prompt) {
    formData.append('prompt', prompt);
  }

  let response;
  try {
    response = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
      },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    console.error('[Whisper] Fetch error:', err.message);
    throw err;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('[Whisper] API error:', response.status, errBody.slice(0, 300));
    const err = new Error('Whisper API error: HTTP ' + response.status);
    err.response = { status: response.status, data: errBody };
    throw err;
  }

  const data = await response.json();
  const text = (data.text || '').trim();
  console.log('[Whisper] Transcribed (' + sentBy + '):', text.slice(0, 200));

  // Clean up the temp file
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // ignore cleanup errors
  }

  return text;
}

/**
 * Download a Telegram voice message file to a temp location.
 * @param {object} bot - node-telegram-bot-api instance
 * @param {string} fileId - Telegram file ID from msg.voice.file_id
 * @returns {Promise<string>} - Path to the downloaded file
 */
async function downloadVoiceFile(bot, fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + fileInfo.file_path;
  const ext = path.extname(fileInfo.file_path) || '.ogg';
  const tmpPath = path.join(os.tmpdir(), 'jarvis_voice_' + Date.now() + ext);

  const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(tmpPath, Buffer.from(response.data));
  console.log('[Whisper] Downloaded voice file to:', tmpPath, '(' + response.data.byteLength + ' bytes)');
  return tmpPath;
}

module.exports = { transcribe, downloadVoiceFile };
