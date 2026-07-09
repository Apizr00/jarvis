// src/llm/whisper.js
// Voice Transcription — ILMU ASR v4.2 (primary) + OpenAI Whisper (fallback)
//
// ILMU ASR v4.2: Malaysia-optimized, handles code-switching (BM+English+
// Mandarin), OpenAI-compatible endpoint. Cheaper (RM 0.0002/sec vs OpenAI).
//
// Falls back to OpenAI Whisper when ILMU_API_KEY is not configured.

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ILMU_BASE = (process.env.ILMU_BASE_URL || 'https://api.ilmu.ai').replace(/\/+$/, '');
const ILMU_ASR_URL = ILMU_BASE.endsWith('/v1') ? ILMU_BASE + '/audio/transcriptions' : ILMU_BASE + '/v1/audio/transcriptions';
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Supported language codes (ISO-639-1) */
const VALID_LANGS = ['en', 'ms', 'zh', 'ja', 'ko', 'ar', 'id', 'th', 'vi', 'hi', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'nl', 'tr', 'pl', 'sv', 'da', 'no', 'fi', 'cs', 'hu', 'ro', 'sk', 'uk', 'el', 'he'];

/**
 * Transcribe an audio file.
 * Tries ILMU ASR v4.2 first (better for Malaysian speech), falls back to OpenAI Whisper.
 * @param {string} filePath - Path to the audio file (ogg/mp3/wav)
 * @param {'telegram_bot'|'user'} sentBy - Who sent the voice message
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribe(filePath, sentBy = 'telegram_bot') {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = fileName.endsWith('.mp3') ? 'audio/mpeg'
    : fileName.endsWith('.wav') ? 'audio/wav'
      : fileName.endsWith('.m4a') ? 'audio/mp4'
        : 'audio/ogg';

  // ── Try ILMU ASR v4.2 first (Malaysian-optimized, cheaper) ──────────
  if (process.env.ILMU_API_KEY) {
    try {
      const text = await transcribeWithIlmu(fileBuffer, fileName, mimeType);
      if (text) {
        console.log('[ASR] ILMU transcribed (' + sentBy + '):', text.slice(0, 200));
        cleanupFile(filePath);
        return text;
      }
    } catch (err) {
      console.warn('[ASR] ILMU ASR failed, falling back to OpenAI Whisper:', err.message);
    }
  }

  // ── Fallback: OpenAI Whisper ─────────────────────────────────────────
  return transcribeWithWhisper(fileBuffer, fileName, mimeType, sentBy, filePath);
}

/**
 * Transcribe using ILMU ASR v4.2 (OpenAI-compatible endpoint).
 */
async function transcribeWithIlmu(fileBuffer, fileName, mimeType) {
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
  formData.append('model', 'ilmu-asr-v4.2');
  formData.append('response_format', 'json');

  const lang = process.env.WHISPER_LANGUAGE || process.env.ILMU_ASR_LANGUAGE;
  if (lang && VALID_LANGS.includes(lang.toLowerCase())) {
    formData.append('language', lang.toLowerCase());
  }

  const prompt = process.env.WHISPER_PROMPT || process.env.ILMU_ASR_PROMPT;
  if (prompt) {
    formData.append('prompt', prompt);
  }

  const response = await fetch(ILMU_ASR_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.ILMU_API_KEY },
    body: formData,
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error('ILMU ASR HTTP ' + response.status + ': ' + errBody.slice(0, 200));
  }

  const data = await response.json();
  return (data.text || '').trim();
}

/**
 * Transcribe using OpenAI Whisper (original fallback).
 */
async function transcribeWithWhisper(fileBuffer, fileName, mimeType, sentBy, filePath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('No transcription API key configured. Set ILMU_API_KEY or OPENAI_API_KEY in .env');
  }

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'json');

  const lang = process.env.WHISPER_LANGUAGE;
  if (lang && VALID_LANGS.includes(lang.toLowerCase())) {
    formData.append('language', lang.toLowerCase());
  } else if (lang) {
    console.log('[Whisper] Multiple languages requested, using auto-detect:', lang);
  }

  const prompt = process.env.WHISPER_PROMPT;
  if (prompt) {
    formData.append('prompt', prompt);
  }

  const response = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    body: formData,
    signal: AbortSignal.timeout(30000),
  });

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

  cleanupFile(filePath);
  return text;
}

function cleanupFile(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
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
