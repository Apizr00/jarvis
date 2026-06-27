// src/llm/index.js
// LLM Router — tries DeepSeek (primary), falls back to MiMo (backup)
const deepseek = require('./deepseek');
const mimo = require('./mimo');

/**
 * Chat with the LLM. Tries primary provider first, auto-falls back to backup.
 * @param {string} userId
 * @param {string} userMessage
 * @param {Array} conversationHistory
 * @returns {Promise<{type:string, content?:string, name?:string, args?:object}>}
 */
async function chat(userId, userMessage, conversationHistory) {
  // ── Try primary: DeepSeek ──────────────────────────────────────────────────
  try {
    const result = await deepseek.chat(userId, userMessage, conversationHistory);
    return result;
  } catch (primaryErr) {
    console.warn('⚠️  DeepSeek failed (' + primaryErr.message + '), trying MiMo backup...');
  }

  // ── Fallback: MiMo ────────────────────────────────────────────────────────
  try {
    const result = await mimo.chat(userId, userMessage, conversationHistory);
    console.log('✅ MiMo backup succeeded');
    return result;
  } catch (backupErr) {
    console.error('❌ Both providers failed. MiMo error:', backupErr.message);
    throw new Error('All LLM providers are unavailable. Please try again later.');
  }
}

module.exports = { chat };
