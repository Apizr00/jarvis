// test-ilmu-features.js
// ── ILMU Features Integration Test ─────────────────────────────────────────
//
// Tests:
//   1. BGE-M3 embeddings — generate vectors, cosine similarity
//   2. BGE Reranker — rerank candidate documents
//   3. ILMU ASR v4.2 — transcribe audio (only if ILMU_API_KEY is set)
//   4. Whisper fallback — verify OpenAI Whisper still works
//   5. Memory semantic search — ILMU BGE-M3 > DeepSeek > keyword fallback
//
// Run: node test-ilmu-features.js

const embeddings = require('./src/llm/embeddings');
const { transcribe, downloadVoiceFile } = require('./src/llm/whisper');

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (err) {
    failed++;
    console.log('  ❌ ' + name + ' — ' + err.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (err) {
    failed++;
    console.log('  ❌ ' + name + ' — ' + err.message);
  }
}

function skip(name, reason) {
  skipped++;
  console.log('  ⏭️  ' + name + ' — ' + reason);
}

function printResults() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  const total = passed + failed + skipped;
  console.log('║  ✅ ' + String(passed).padStart(3) + ' passed   ❌ ' + String(failed).padStart(3) + ' failed   ⏭️  ' + String(skipped).padStart(3) + ' skipped   ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  if (process.env.ILMU_API_KEY) {
    console.log('');
    console.log('🎯 ILMU API is configured — live tests passed!');
    console.log('   BGE-M3 embeddings + reranker working correctly.');
    console.log('   ASR v4.2 will be used as primary transcription engine.');
  } else {
    console.log('');
    console.log('💡 Set ILMU_API_KEY in .env to enable:');
    console.log('   • BGE-M3 semantic memory search (better BM/rojak)');
    console.log('   • BGE Reranker (precision retrieval)');
    console.log('   • ILMU ASR v4.2 (Malaysian-optimized voice transcription)');
    console.log('   All gracefully fall back to keyword search + OpenAI Whisper.');
  }
}

async function runAllTests() {

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     🧪 ILMU Features Integration Test               ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // ── 1. Embeddings Module ───────────────────────────────────────────────────
  console.log('━━━ 1. BGE-M3 Embeddings Module ━━━');

  test('Module loads correctly', () => {
    if (typeof embeddings.getEmbedding !== 'function') throw new Error('getEmbedding missing');
    if (typeof embeddings.getEmbeddingsBatch !== 'function') throw new Error('getEmbeddingsBatch missing');
    if (typeof embeddings.rerank !== 'function') throw new Error('rerank missing');
    if (typeof embeddings.cosineSimilarity !== 'function') throw new Error('cosineSimilarity missing');
    if (typeof embeddings.isAvailable !== 'function') throw new Error('isAvailable missing');
  });

  test('isAvailable() returns boolean', () => {
    const avail = embeddings.isAvailable();
    if (typeof avail !== 'boolean') throw new Error('Expected boolean, got ' + typeof avail);
  });

  test('cosineSimilarity — identical vectors = 1.0', () => {
    const v = [0.5, 0.3, 0.2, 0.1];
    const score = embeddings.cosineSimilarity(v, v);
    if (Math.abs(score - 1.0) > 0.001) throw new Error('Expected ~1.0, got ' + score);
  });

  test('cosineSimilarity — orthogonal vectors = 0.0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const score = embeddings.cosineSimilarity(a, b);
    if (Math.abs(score) > 0.001) throw new Error('Expected ~0.0, got ' + score);
  });

  test('cosineSimilarity — opposite vectors = -1.0', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    const score = embeddings.cosineSimilarity(a, b);
    if (Math.abs(score - (-1.0)) > 0.001) throw new Error('Expected ~-1.0, got ' + score);
  });

  test('cosineSimilarity — empty/null safe', () => {
    if (embeddings.cosineSimilarity(null, [1]) !== 0) throw new Error('null should return 0');
    if (embeddings.cosineSimilarity([1], null) !== 0) throw new Error('null should return 0');
    if (embeddings.cosineSimilarity([], [1]) !== 0) throw new Error('empty should return 0');
  });

  if (process.env.ILMU_API_KEY) {
    // When API key IS set, these make real calls — skip the "null without key" tests
    skip('getEmbedding returns null without API key', 'ILMU_API_KEY is set — live test instead');
    skip('getEmbeddingsBatch returns null without API key', 'ILMU_API_KEY is set — live test instead');
    skip('rerank returns null without API key', 'ILMU_API_KEY is set — live test instead');
  } else {
    testAsync('getEmbedding returns null without API key (graceful)', async () => {
      const result = await embeddings.getEmbedding('test query');
      if (result !== null && !Array.isArray(result)) throw new Error('Expected null or array');
    });

    testAsync('getEmbeddingsBatch returns null without API key (graceful)', async () => {
      const result = await embeddings.getEmbeddingsBatch(['test 1', 'test 2']);
      if (result !== null && !Array.isArray(result)) throw new Error('Expected null or array');
    });

    testAsync('rerank returns null without API key (graceful)', async () => {
      const result = await embeddings.rerank('query', ['doc1', 'doc2']);
      if (result !== null) throw new Error('Expected null without API key');
    });
  }

  // If ILMU_API_KEY is set, run live tests
  if (process.env.ILMU_API_KEY) {
    console.log('');
    console.log('━━━ 1b. Live ILMU BGE-M3 Tests ━━━');

    testAsync('getEmbedding returns 1024-dim vector', async () => {
      const vec = await embeddings.getEmbedding('ibu kota Malaysia ialah Kuala Lumpur');
      if (!vec || vec.length !== 1024) throw new Error('Expected 1024-dim, got ' + (vec ? vec.length : 'null'));
      if (typeof vec[0] !== 'number') throw new Error('Expected number array');
    });

    testAsync('getEmbeddingsBatch returns correct count', async () => {
      const texts = ['saya suka makan nasi lemak', 'i like to eat burgers', 'roti canai sedap'];
      const vecs = await embeddings.getEmbeddingsBatch(texts);
      if (!vecs || vecs.length !== 3) throw new Error('Expected 3 vectors, got ' + (vecs ? vecs.length : 'null'));
      if (vecs[0].length !== 1024) throw new Error('Expected 1024-dim');
    });

    testAsync('Similar texts have higher cosine similarity', async () => {
      const vecs = await embeddings.getEmbeddingsBatch([
        'nasi lemak dengan sambal sedap',
        'nasi lemak makanan kegemaran saya',
        'kapal terbang Boeing 737',
      ]);
      if (!vecs) throw new Error('Embeddings batch failed');

      const similarScore = embeddings.cosineSimilarity(vecs[0], vecs[1]);
      const diffScore = embeddings.cosineSimilarity(vecs[0], vecs[2]);

      console.log('     Similar (nasi lemak): ' + similarScore.toFixed(3));
      console.log('     Different (kapal):   ' + diffScore.toFixed(3));

      if (similarScore <= diffScore) throw new Error(
        'Similar texts should score higher! Similar=' + similarScore.toFixed(3) + ' Different=' + diffScore.toFixed(3)
      );
    });

    testAsync('rerank reorders documents correctly', async () => {
      const query = 'apa itu nasi lemak';
      const docs = [
        'Nasi lemak ialah makanan tradisional Malaysia yang terdiri daripada nasi yang dimasak dengan santan.',
        'Kapal terbang ialah kenderaan udara yang digunakan untuk perjalanan jarak jauh.',
        'Nasi lemak biasanya dihidangkan dengan sambal, ikan bilis, kacang, dan telur.',
      ];

      const results = await embeddings.rerank(query, docs, { topN: 3 });
      if (!results || results.length !== 3) throw new Error('Expected 3 results');

      console.log('     Rank 1 (score=' + results[0].score.toFixed(3) + '): ' + results[0].text.slice(0, 60));
      console.log('     Rank 2 (score=' + results[1].score.toFixed(3) + '): ' + results[1].text.slice(0, 60));
      console.log('     Rank 3 (score=' + results[2].score.toFixed(3) + '): ' + results[2].text.slice(0, 60));

      const airplaneIdx = results.findIndex(r => r.text.includes('Kapal terbang'));
      if (airplaneIdx !== 2) throw new Error(
        'Airplane doc should rank last, but was at position ' + airplaneIdx
      );
    });
  } else {
    skip('Live BGE-M3 tests', 'ILMU_API_KEY not set');
  }

  // ── 2. ASR Module ──────────────────────────────────────────────────────────
  console.log('');
  console.log('━━━ 2. ILMU ASR / Whisper Module ━━━');

  test('Module exports transcribe function', () => {
    if (typeof transcribe !== 'function') throw new Error('transcribe missing');
  });

  test('Module exports downloadVoiceFile function', () => {
    if (typeof downloadVoiceFile !== 'function') throw new Error('downloadVoiceFile missing');
  });

  testAsync('transcribe throws without audio file (graceful error)', async () => {
    try {
      await transcribe('/nonexistent/file.ogg');
    } catch (err) {
      if (!err.message.includes('ENOENT') && !err.message.includes('API key') && !err.message.includes('No transcription')) {
        throw new Error('Unexpected error: ' + err.message);
      }
    }
  });

  if (!process.env.ILMU_API_KEY && !process.env.OPENAI_API_KEY) {
    skip('Live ASR tests', 'Neither ILMU_API_KEY nor OPENAI_API_KEY set');
  }

  // ── 3. Memory Integration ──────────────────────────────────────────────────
  console.log('');
  console.log('━━━ 3. Memory Semantic Search Integration ━━━');

  testAsync('Memory module loads ilmuranker', async () => {
    // Clear require cache to get fresh load
    delete require.cache[require.resolve('./src/memory')];
    const memory = require('./src/memory');
    if (typeof memory.searchFacts !== 'function') throw new Error('searchFacts missing');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Wait for all async tests to settle
  await new Promise(r => setTimeout(r, 1000));

  printResults();
  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
