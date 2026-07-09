// src/llm/tts.js
// ── ILMU TTS v2 — Text-to-Speech ────────────────────────────────────────────
//
// Uses ILMU's TTS endpoint (OpenAI-compatible /v1/audio/speech) to convert
// text into spoken audio. Supports 3 voices: voice_1 (female), voice_2 (male),
// voice_3 (male alternate).
//
// Output formats: mp3, wav, opus, flac
// Max input: 10,000 characters per request
// Pricing: RM 0.08 per 1,000 characters
//
// Falls back gracefully when ILMU_API_KEY is unavailable.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');

const ILMU_BASE = (process.env.ILMU_BASE_URL || 'https://api.ilmu.ai').replace(/\/+$/, '');
const TTS_URL = ILMU_BASE.endsWith('/v1') ? ILMU_BASE + '/audio/speech' : ILMU_BASE + '/v1/audio/speech';

// Telegram voice notes work best with Opus in OGG container
const DEFAULT_FORMAT = 'opus';
const DEFAULT_VOICE = process.env.ILMU_TTS_VOICE || 'voice_1';    // female
const MAX_CHARS = 10000;

/**
 * Generate speech audio from text using ILMU TTS v2.
 * Returns a Buffer of audio data.
 *
 * @param {object} opts
 * @param {string} opts.text - text to speak (max 10,000 chars)
 * @param {string} [opts.voice] - 'voice_1' (female), 'voice_2' (male), 'voice_3' (male)
 * @param {string} [opts.format] - 'opus' (default), 'mp3', 'wav', 'flac'
 * @returns {Promise<{buffer:Buffer, format:string}|null>} audio buffer + format
 */
async function speak({ text, voice, format } = {}) {
  const apiKey = process.env.ILMU_API_KEY;
  if (!apiKey || !text) return null;

  const trimmed = text.slice(0, MAX_CHARS);
  const fmt = format || DEFAULT_FORMAT;
  const vc = voice || DEFAULT_VOICE;

  try {
    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'ilmu-tts-v2',
        input: trimmed,
        voice: vc,
        response_format: fmt,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.warn('[TTS] API error HTTP ' + response.status + ':', errBody.slice(0, 200));
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log('[TTS] Generated ' + fmt + ' audio: ' + buffer.length + ' bytes for ' + trimmed.length + ' chars');
    return { buffer, format: fmt };
  } catch (err) {
    console.warn('[TTS] Error:', err.message);
    return null;
  }
}

/**
 * Generate speech and save to a temp file. Returns the file path.
 * @returns {Promise<string|null>} file path or null
 */
async function speakToFile({ text, voice, format } = {}) {
  const result = await speak({ text, voice, format });
  if (!result) return null;

  const ext = result.format === 'opus' ? '.ogg' : '.' + result.format;
  const tmpPath = path.join(os.tmpdir(), 'jarvis_tts_' + Date.now() + ext);
  fs.writeFileSync(tmpPath, result.buffer);

  console.log('[TTS] Saved to:', tmpPath);
  return tmpPath;
}

/**
 * Quick check: is TTS available?
 */
function isAvailable() {
  return !!process.env.ILMU_API_KEY;
}

module.exports = { speak, speakToFile, isAvailable };
