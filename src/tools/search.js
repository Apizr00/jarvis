// src/tools/search.js
// Web search via Tavily Search API (free tier: 1,000 searches/month)
const axios = require('axios');

const API_KEY = process.env.TAVILY_API_KEY;
const BASE_URL = 'https://api.tavily.com/search';

/**
 * Perform a web search using the Tavily API.
 * @param {string} query - The search query
 * @returns {Promise<string>} - Formatted search results for Telegram
 */
async function webSearch(query) {
  if (!API_KEY) {
    return '⚠️ Web search is not configured. Add your TAVILY_API_KEY to the .env file.\n\nGet a free key at: https://tavily.com';
  }

  if (!query || query.trim().length === 0) {
    return '⚠️ I need a search query. What would you like me to search for?';
  }

  try {
    const { data } = await axios.post(
      BASE_URL,
      {
        query: query.trim(),
        search_depth: 'basic',
        include_images: false,
        include_answer: true,
        max_results: 5,
      },
      {
        headers: {
          'Authorization': 'Bearer ' + API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      }
    );

    // Build a nice Markdown response
    let reply = '🔍 *Web Search: *' + escapeSearchMd(query) + '\n\n';

    // Tavily provides an AI-generated answer summary
    if (data.answer) {
      reply += escapeSearchMd(data.answer) + '\n\n';
    }

    // List individual results with sources
    if (data.results && data.results.length > 0) {
      reply += '*Sources:*\n';
      data.results.forEach((r, i) => {
        const title = escapeSearchMd(r.title || 'Untitled');
        const url = escapeSearchMd(r.url || '');
        reply += (i + 1) + '\\. [' + title + '](' + url + ')\n';
      });
    } else {
      reply += '_No results found._';
    }

    return reply.trim();

  } catch (err) {
    // Handle Tavily-specific errors
    if (err.response) {
      const status = err.response.status;
      if (status === 401 || status === 403) {
        return '🔑 Invalid Tavily API key. Check your TAVILY_API_KEY in .env';
      }
      if (status === 429) {
        return '⏳ Rate limited. Tavily free tier allows 1,000 searches/month. Try again later.';
      }
      console.warn('⚠️  Tavily search error (HTTP ' + status + '):', err.response.data);
    } else {
      console.warn('⚠️  Tavily search failed:', err.message);
    }
    return '⚠️ Search failed. Please try again in a moment.';
  }
}

/**
 * Escape special characters for Telegram Markdown.
 * Same as escapeMd in tools/index.js but local to avoid circular deps.
 */
function escapeSearchMd(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/([_*`\[])/g, '\\$1');
}

module.exports = { webSearch };
