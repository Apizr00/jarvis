// src/llm/vision.js
// ── ILMU Vision v1.3 — Image & Document Analysis ────────────────────────────
//
// Uses ILMU's vision-capable models via the standard /v1/chat/completions
// endpoint with image_url content parts. Both ilmu-v3.1 and ilmu-vision-v1.3
// support vision.
//
// Supports: JPEG, PNG, WebP, GIF, PDF (via base64 data URI)
// Max: 20 MB per image, 25 MB total, 5 images per request
// Pricing: RM 1.60 / 4.80 per 1M tokens (input/output)
//
// Falls back gracefully when ILMU_API_KEY is unavailable.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ILMU_BASE = (process.env.ILMU_BASE_URL || 'https://api.ilmu.ai').replace(/\/+$/, '');
const CHAT_URL = ILMU_BASE.endsWith('/v1') ? ILMU_BASE + '/chat/completions' : ILMU_BASE + '/v1/chat/completions';

// ilmu-v3.1 has vision + tool calling; ilmu-vision-v1.3 is vision-specialized
const VISION_MODEL = process.env.ILMU_VISION_MODEL || 'ilmu-v3.1';

/**
 * Analyze an image or document using ILMU Vision.
 *
 * @param {object} opts
 * @param {Buffer} opts.imageBuffer - raw image bytes
 * @param {string} opts.mimeType - e.g. 'image/jpeg', 'image/png', 'application/pdf'
 * @param {string} [opts.prompt] - what to ask about the image (default: "Describe this image")
 * @param {string} [opts.language] - preferred response language ('ms', 'en', or null for auto)
 * @returns {Promise<string|null>} analysis text or null on failure
 */
async function analyzeImage({ imageBuffer, mimeType, prompt, language } = {}) {
  const apiKey = process.env.ILMU_API_KEY;
  if (!apiKey || !imageBuffer) return null;

  const b64 = imageBuffer.toString('base64');
  const dataUri = 'data:' + (mimeType || 'image/jpeg') + ';base64,' + b64;

  let userPrompt = prompt || 'Describe this image in detail.';
  if (language === 'ms') {
    userPrompt = prompt || 'Terangkan gambar ini dalam Bahasa Melayu secara terperinci.';
  }

  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        }],
        max_tokens: 800,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.warn('[Vision] API error HTTP ' + response.status + ':', errBody.slice(0, 200));
      return null;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    console.log('[Vision] Analysis complete (' + text.length + ' chars):', text.slice(0, 150));
    return text.trim();
  } catch (err) {
    console.warn('[Vision] Error:', err.message);
    return null;
  }
}

/**
 * Analyze an image file from disk.
 * @param {string} filePath - path to image file
 * @param {string} [prompt] - what to ask
 * @param {string} [language] - 'ms' or 'en'
 */
async function analyzeImageFile(filePath, prompt, language) {
  if (!fs.existsSync(filePath)) return null;

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
  };
  const mimeType = mimeMap[ext] || 'image/jpeg';
  const buffer = fs.readFileSync(filePath);

  return analyzeImage({ imageBuffer: buffer, mimeType, prompt, language });
}

/**
 * Quick check: is Vision available?
 */
function isAvailable() {
  return !!process.env.ILMU_API_KEY;
}

module.exports = { analyzeImage, analyzeImageFile, isAvailable };
