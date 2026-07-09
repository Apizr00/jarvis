// test-vision-tts.js
// ── ILMU Vision + TTS Integration Test ─────────────────────────────────────
//
// Tests:
//   1. Vision module — analyzeImage, analyzeImageFile, isAvailable
//   2. TTS module — speak, speakToFile, isAvailable
//   3. Live tests (only if ILMU_API_KEY is set)
//
// Run: node test-vision-tts.js

const vision = require('./src/llm/vision');
const tts = require('./src/llm/tts');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (err) { failed++; console.log('  ❌ ' + name + ' — ' + err.message); }
}

async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); }
  catch (err) { failed++; console.log('  ❌ ' + name + ' — ' + err.message); }
}

function skip(name, reason) {
  skipped++; console.log('  ⏭️  ' + name + ' — ' + reason);
}

function printResults(title) {
  const total = passed + failed + skipped;
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  ' + title.padEnd(52) + '║');
  console.log('║  ✅ ' + String(passed).padStart(3) + ' passed   ❌ ' + String(failed).padStart(3) + ' failed   ⏭️  ' + String(skipped).padStart(3) + ' skipped   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
}

async function runAllTests() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     🧪 ILMU Vision + TTS Integration Test           ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // ── 1. Vision Module ───────────────────────────────────────────────────
  console.log('\n━━━ 1. ILMU Vision v1.3 ━━━');

  test('Module loads correctly', () => {
    if (typeof vision.analyzeImage !== 'function') throw new Error('analyzeImage missing');
    if (typeof vision.analyzeImageFile !== 'function') throw new Error('analyzeImageFile missing');
    if (typeof vision.isAvailable !== 'function') throw new Error('isAvailable missing');
  });

  test('isAvailable() returns boolean', () => {
    if (typeof vision.isAvailable() !== 'boolean') throw new Error('Expected boolean');
  });

  testAsync('analyzeImage returns null without API key (graceful)', async () => {
    const result = await vision.analyzeImage({
      imageBuffer: Buffer.from('fake-image-data'),
      mimeType: 'image/jpeg',
    });
    if (result !== null && typeof result !== 'string') throw new Error('Expected null or string');
  });

  testAsync('analyzeImageFile returns null for nonexistent file', async () => {
    const result = await vision.analyzeImageFile('/nonexistent/photo.jpg');
    if (result !== null) throw new Error('Expected null for missing file');
  });

  if (process.env.ILMU_API_KEY) {
    console.log('');
    console.log('━━━ 1b. Live Vision Test ━━━');

    // Create a minimal valid 1x1 white PNG
    // PNG signature + IHDR + IDAT + IEND chunks
    const pngData = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
      0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
      0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
      0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);

    testAsync('analyzeImage returns description for image', async () => {
      const result = await vision.analyzeImage({
        imageBuffer: pngData,
        mimeType: 'image/png',
        prompt: 'What is this image? Reply in ONE short sentence.',
        language: 'en',
      });
      if (!result || result.length < 1) throw new Error('Expected non-empty response');
      console.log('     Response: ' + result.slice(0, 120));
    });

    testAsync('analyzeImage with BM prompt', async () => {
      const result = await vision.analyzeImage({
        imageBuffer: pngData,
        mimeType: 'image/png',
        prompt: 'Terangkan gambar ini dalam SATU ayat pendek Bahasa Melayu.',
        language: 'ms',
      });
      if (!result || result.length < 1) throw new Error('Expected non-empty response');
      console.log('     Response: ' + result.slice(0, 120));
    });
  } else {
    skip('Live Vision tests', 'ILMU_API_KEY not set');
  }

  // ── 2. TTS Module ──────────────────────────────────────────────────────
  console.log('\n━━━ 2. ILMU TTS v2 ━━━');

  test('Module loads correctly', () => {
    if (typeof tts.speak !== 'function') throw new Error('speak missing');
    if (typeof tts.speakToFile !== 'function') throw new Error('speakToFile missing');
    if (typeof tts.isAvailable !== 'function') throw new Error('isAvailable missing');
  });

  testAsync('speak returns null without API key (graceful)', async () => {
    const result = await tts.speak({ text: 'Hello world' });
    if (result !== null && !result?.buffer) throw new Error('Expected null or buffer');
  });

  testAsync('speakToFile returns null without API key (graceful)', async () => {
    const result = await tts.speakToFile({ text: 'Test' });
    if (result !== null && typeof result !== 'string') throw new Error('Expected null or string');
  });

  if (process.env.ILMU_API_KEY) {
    console.log('');
    console.log('━━━ 2b. Live TTS Test ━━━');

    testAsync('speak returns audio buffer', async () => {
      const result = await tts.speak({ text: 'Selamat pagi Malaysia', voice: 'voice_1', format: 'opus' });
      if (!result || !result.buffer || result.buffer.length < 100) {
        throw new Error('Expected audio buffer > 100 bytes, got ' + (result?.buffer?.length || 'null'));
      }
      console.log('     Audio size: ' + result.buffer.length + ' bytes, format: ' + result.format);

      // Opus/OGG magic bytes: "OggS"
      const header = result.buffer.slice(0, 4).toString();
      console.log('     File header: ' + header);
    });

    testAsync('speakToFile creates temp file', async () => {
      const filePath = await tts.speakToFile({ text: 'Hello world test', format: 'opus' });
      if (!filePath || !fs.existsSync(filePath)) throw new Error('File not created: ' + filePath);
      const stats = fs.statSync(filePath);
      if (stats.size < 100) throw new Error('File too small: ' + stats.size + ' bytes');
      console.log('     File: ' + filePath + ' (' + stats.size + ' bytes)');
      fs.unlinkSync(filePath); // cleanup
    });

    testAsync('TTS handles long BM text', async () => {
      const result = await tts.speak({
        text: 'Ini adalah ujian untuk sistem text to speech dalam Bahasa Melayu. Semoga berjaya.',
        voice: 'voice_2',
        format: 'opus',
      });
      if (!result || result.buffer.length < 100) throw new Error('Expected audio buffer');
      console.log('     Long text audio: ' + result.buffer.length + ' bytes');
    });
  } else {
    skip('Live TTS tests', 'ILMU_API_KEY not set');
  }

  printResults('ILMU Vision + TTS');
}

runAllTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
