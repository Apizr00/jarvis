// src/llm/embeddings.js
// ── ILMU BGE-M3 Embeddings + Reranker ───────────────────────────────────────
//
// Uses ILMU API's BGE-M3 for semantic embeddings and BGE Reranker for
// precision retrieval. Both are OpenAI-compatible via the same base URL
// and API key.
//
// Pricing (PAYG): RM 0.04 / 1M tokens for both embeddings + rerank.
//
// Endpoints:
//   Embeddings: POST /v1/embeddings  (model: bge-m3, 1024-dim vectors)
//   Rerank:     POST /v1/rerank      (model: bge-reranker)
//
// Falls back gracefully to keyword search when ILMU_API_KEY is unavailable.

require('dotenv').config();

const ILMU_BASE = (process.env.ILMU_BASE_URL || 'https://api.ilmu.ai').replace(/\/+$/, '');
const EMBED_URL = ILMU_BASE.endsWith('/v1') ? ILMU_BASE + '/embeddings' : ILMU_BASE + '/v1/embeddings';
const RERANK_URL = ILMU_BASE.endsWith('/v1') ? ILMU_BASE + '/rerank' : ILMU_BASE + '/v1/rerank';

// ── Embedding ────────────────────────────────────────────────────────────────

/**
 * Get embedding vector for a single text using ILMU BGE-M3.
 * @param {string} text - text to embed
 * @returns {Promise<number[]|null>} 1024-dim vector or null on failure
 */
async function getEmbedding(text) {
  const apiKey = process.env.ILMU_API_KEY;
  if (!apiKey || !text) return null;

  try {
    const response = await fetch(EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'bge-m3',
        input: text,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn('[Embeddings] BGE-M3 request failed: HTTP ' + response.status);
      return null;
    }

    const data = await response.json();
    return data?.data?.[0]?.embedding || null;
  } catch (err) {
    console.warn('[Embeddings] BGE-M3 error:', err.message);
    return null;
  }
}

/**
 * Get embeddings for multiple texts in a single batch request.
 * Much faster than calling getEmbedding() for each text individually.
 * @param {string[]} texts - array of texts (max 2048)
 * @returns {Promise<Array<number[]>|null>} array of embedding vectors
 */
async function getEmbeddingsBatch(texts) {
  const apiKey = process.env.ILMU_API_KEY;
  if (!apiKey || !texts || texts.length === 0) return null;

  try {
    const response = await fetch(EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'bge-m3',
        input: texts,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.warn('[Embeddings] BGE-M3 batch request failed: HTTP ' + response.status);
      return null;
    }

    const data = await response.json();
    if (!data?.data) return null;

    // Return embeddings in input order (ILMU returns them indexed)
    const embeddings = new Array(texts.length);
    for (const item of data.data) {
      embeddings[item.index] = item.embedding;
    }
    return embeddings;
  } catch (err) {
    console.warn('[Embeddings] BGE-M3 batch error:', err.message);
    return null;
  }
}

// ── Rerank ───────────────────────────────────────────────────────────────────

/**
 * Rerank a list of documents against a query using ILMU BGE Reranker.
 * Returns documents sorted by relevance with scores.
 *
 * @param {string} query - the search query
 * @param {string[]} documents - candidate documents to rerank
 * @param {object} [options]
 * @param {number} [options.topN] - return only top N results
 * @returns {Promise<Array<{index:number, score:number, text:string}>|null>}
 */
async function rerank(query, documents, options = {}) {
  const apiKey = process.env.ILMU_API_KEY;
  if (!apiKey || !query || !documents || documents.length === 0) return null;

  const topN = options.topN || documents.length;

  try {
    const response = await fetch(RERANK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'bge-reranker',
        query,
        documents,
        top_n: Math.min(topN, documents.length),
        return_documents: true,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      console.warn('[Embeddings] Rerank request failed: HTTP ' + response.status);
      return null;
    }

    const data = await response.json();
    if (!data?.results) return null;

    return data.results.map(r => ({
      index: r.index,
      score: r.relevance_score,
      text: typeof r.document === 'string' ? r.document : String(documents[r.index] || ''),
    }));
  } catch (err) {
    console.warn('[Embeddings] Rerank error:', err.message);
    return null;
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * Calculate cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} similarity score (0-1)
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Check if ILMU embeddings are available.
 */
function isAvailable() {
  return !!process.env.ILMU_API_KEY;
}

module.exports = {
  getEmbedding,
  getEmbeddingsBatch,
  rerank,
  cosineSimilarity,
  isAvailable,
};
