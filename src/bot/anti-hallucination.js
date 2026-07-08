// src/bot/anti-hallucination.js
// ── Anti-Hallucination Guards ───────────────────────────────────────────────
// Post-processes LLM responses to fix common hallucinations:
//   1. Wrong time-of-day greetings (e.g. "Selamat pagi" at 8pm)
//   2. Fabricated current times (e.g. "pukul 6:50" when it's actually 2:15)
//   3. Hallucinated relative time phrases near current time mentions
//
// Both functions are pure — they take text in and return fixed text.
// They do NOT call any external services or modify global state.

// ── Greeting hallucination guard ──────────────────────────────────────────

/**
 * Detects and fixes wrong time-of-day Malay greetings in the bot's reply.
 * LLMs often default to "Selamat pagi" regardless of actual time.
 * 
 * @param {string} text - the bot's response text
 * @returns {string} corrected text
 */
function fixHallucinatedGreeting(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  // ⚡ Early exit: skip if no greeting keywords
  if (!/(selamat\s*(pagi|petang|malam|tengah\s*hari))/i.test(text)) return text;

  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();
  const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);

  // Determine the correct time period
  let correctPeriod;
  if (hour >= 5 && hour < 12) {
    correctPeriod = 'pagi';
  } else if (hour >= 12 && hour < 14) {
    correctPeriod = 'tengah hari';
  } else if (hour >= 14 && hour < 19) {
    correctPeriod = 'petang';
  } else {
    correctPeriod = 'malam';
  }

  // Patterns for each greeting, with the opening "Selamat X" pattern
  // We only fix the OPENING greeting (start of message or after punctuation/newline)
  // "Selamat malam" as farewell at end of message is NOT replaced
  const greetingPatterns = [
    { pattern: /\b(Selamat\s+pagi)\b/gi, period: 'pagi' },
    { pattern: /\b(Selamat\s+tengah\s+hari)\b/gi, period: 'tengah hari' },
    { pattern: /\b(Selamat\s+petang)\b/gi, period: 'petang' },
    { pattern: /(?<!\bbye\b|\bgoodbye\b|\bbai\b|\bjumpa\b|\bnight\b)\s*(Selamat\s+malam)\b(?!\s*(?:lah|je|aja|semua|semuanya|dunia|sayang|sayangku))/gi, period: 'malam' },
  ];

  const replacements = [];

  for (const { pattern, period } of greetingPatterns) {
    if (period === correctPeriod) continue; // already correct, skip

    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      // For "selamat malam", only fix if it's used as an opening greeting
      // (near the start of the message), not as a farewell
      if (period === 'malam') {
        // Check if this looks like a farewell context — skip if so
        const afterMatch = text.substring(match.index + match[0].length, match.index + match[0].length + 30);
        if (/(?:jumpa|bye|goodbye|bai|tidur|sleep|good\s*night)/i.test(afterMatch)) continue;
        // Also check if it's very late in the message (farewell tends to be at end)
        const positionRatio = match.index / text.length;
        if (positionRatio > 0.7) continue; // likely a farewell, not opening greeting
      }

      const correctGreeting = 'Selamat ' + correctPeriod;
      replacements.push({ index: match.index, oldStr: match[1], newStr: correctGreeting });
      console.log('[AntiHalluc] 👋 Fixing hallucinated greeting: "' + match[1] + '" → "' + correctGreeting + '" (hour=' + hour + ', period=' + correctPeriod + ')');
    }
  }

  if (replacements.length === 0) return text;

  // Sort by index descending for right-to-left replacement
  replacements.sort((a, b) => b.index - a.index);

  let fixed = text;
  for (const r of replacements) {
    const before = fixed.substring(0, r.index);
    const after = fixed.substring(r.index + r.oldStr.length);
    fixed = before + r.newStr + after;
  }

  return fixed;
}

// ── Time hallucination guard ──────────────────────────────────────────────

/**
 * Scans the bot's reply for any time mention that doesn't match the actual
 * current time, and fixes it.
 * Supports Malay ("pukul 6:50", "jam 6.50") and English ("6:50 am", "6.50pm").
 * Guards against fixing future/past references (reminders, events).
 * 
 * @param {string} text - the bot's response text
 * @returns {string} corrected text
 */
function fixHallucinatedTime(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  // ⚡ Early exit: skip if no digits or time keywords — avoids expensive regex
  if (!/\d/.test(text)) return text;
  if (!/(pukul|jam|[.:]\d|pagi|petang|malam|am|pm|tengah)/i.test(text)) return text;

  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();

  // Get current hour and minute in configured timezone
  const hour = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
  const minute = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, minute: '2-digit' }).format(now), 10);
  const actualTotalMins = hour * 60 + minute;

  // Pattern: optional time-word prefix + HH:MM or HH.MM + optional AM/PM/suffix
  const timePattern = /(pukul|jam|dah\s+(?:pukul|jam)\s+|around\s+|about\s+|at\s+|it'?s?\s+|is\s+|now\s+|already\s+)?(\d{1,2})[:.](\d{2})(?!\d)\s*(pagi|am|a\.m\.?|petang|malam|pm|p\.m\.?)?/gi;

  // Collect all replacements (index, oldStr, newStr) to apply from right to left
  const replacements = [];

  let match;
  while ((match = timePattern.exec(text)) !== null) {
    const fullMatch = match[0];
    const prefix = (match[1] || '');
    const matchedHour = parseInt(match[2], 10);
    const matchedMinute = parseInt(match[3], 10);
    const period = (match[4] || '').toLowerCase();

    // Convert to 24h for comparison
    let matched24h = matchedHour;
    if (/(petang|malam|pm|p\.m)/i.test(period)) {
      if (matchedHour !== 12) matched24h = matchedHour + 12;
    } else if (/(pagi|am|a\.m)/i.test(period)) {
      if (matchedHour === 12) matched24h = 0;
    }

    const matchedTotalMins = matched24h * 60 + matchedMinute;
    const diffMins = Math.abs(matchedTotalMins - actualTotalMins);

    // Only fix if > 2 minutes off
    if (diffMins <= 2) continue;

    // ── Guard: only fix times that are clearly meant to be CURRENT time ──
    const prefixLower = prefix.toLowerCase();
    const isCurrentTimeContext =
      /^(dah\s+)?(pukul|jam)\s*$/i.test(prefix) ||
      /\b(now|sekarang|it'?s?\s+now|currently|masa\s+sekarang)\b/i.test(prefix) ||
      /^(it'?s?|is|now|already)\s*$/i.test(prefix);

    // 🔥 Enhanced future context detection — check broader surrounding text
    const before80 = text.substring(Math.max(0, match.index - 80), match.index).toLowerCase();
    const after50 = text.substring(match.index, match.index + 50).toLowerCase();

    const futureKeywords = /\b(?:at|nanti|remind|akan|pada|around|about|by|before|until|hingga|sampai|dalam|lagi|next|esok|tomorrow|lusa|minggu|bulan|ingatkan|remind(?:er)?|event|jadual|schedule|meeting|set(?:kan)?|buat(?:kan)?|create|add|tambah|balik\s*kerja|pulang|keluar|masuk|kelas|appointment|temujanji|nanti\s*(?:pukul|jam|kul)|pada\s*(?:pukul|jam|kul)|dalam\s*\d+\s*(?:minit|jam|hari))\b/i;

    const isFutureContext =
      futureKeywords.test(prefixLower) ||
      /\b(?:ingatkan|remind(?:er)?|event|jadual|schedule|meeting)\b/i.test(fullMatch);

    const isPastContext =
      /\b(tadi|was|earlier|semalam|kelmarin|yesterday|last|baru\s*(?:ni|tadi|saja)|sebentar\s*tadi)\b/i.test(prefixLower);

    if (isFutureContext || isPastContext) {
      console.log('[AntiHalluc] ⏰ Skipping time fix — looks like future/past reference: "' + fullMatch + '" (diff=' + diffMins + 'min)');
      continue;
    }

    // Check broader 80-char context for future/past
    if (futureKeywords.test(before80)) {
      console.log('[AntiHalluc] ⏰ Skipping time fix — broader context suggests future reference: "' + fullMatch + '"');
      continue;
    }
    if (/\b(?:tadi|was|semalam|yesterday|baru\s*(?:ni|tadi))\b/i.test(before80)) {
      console.log('[AntiHalluc] ⏰ Skipping time fix — broader context suggests past reference: "' + fullMatch + '"');
      continue;
    }

    // Check after-context too (e.g., "pukul 5:30 nanti")
    if (futureKeywords.test(after50)) {
      console.log('[AntiHalluc] ⏰ Skipping time fix — after-context suggests future reference: "' + fullMatch + '"');
      continue;
    }

    if (!isCurrentTimeContext) {
      const before = text.substring(Math.max(0, match.index - 40), match.index);
      if (/(?:nanti|akan|remind|ingatkan|at\s*$|pada\s*$|esok|tomorrow)/i.test(before)) {
        console.log('[AntiHalluc] ⏰ Skipping time fix — broader context suggests future reference: "' + fullMatch + '"');
        continue;
      }
      if (/(?:tadi|was|semalam|yesterday)/i.test(before)) {
        console.log('[AntiHalluc] ⏰ Skipping time fix — broader context suggests past reference: "' + fullMatch + '"');
        continue;
      }
    }

    // Format the correct time
    const correctHour12 = hour % 12 === 0 ? 12 : hour % 12;
    const correctMinStr = minute.toString().padStart(2, '0');
    const separator = fullMatch.includes(':') ? ':' : '.';

    let replacement = prefix + correctHour12 + separator + correctMinStr;
    if (period) replacement += ' ' + period;

    replacements.push({ index: match.index, oldStr: fullMatch, newStr: replacement });
  }

  // Also check "tengah hari" / "tengah malam" mentions
  const tengahHariRe = /\btengah\s*hari\b/gi;
  const tengahMalamRe = /\btengah\s*malam\b/gi;
  const isNoon = hour === 12;
  const isMidnight = hour === 0;

  if (!isNoon) {
    while ((match = tengahHariRe.exec(text)) !== null) {
      const correctTime = 'pukul ' + hour + ':' + minute.toString().padStart(2, '0');
      replacements.push({ index: match.index, oldStr: match[0], newStr: correctTime });
    }
  }
  if (!isMidnight) {
    while ((match = tengahMalamRe.exec(text)) !== null) {
      const correctTime = 'pukul ' + hour + ':' + minute.toString().padStart(2, '0');
      replacements.push({ index: match.index, oldStr: match[0], newStr: correctTime });
    }
  }

  // ── Relative time hallucination: "dalam X minit" near current time ──
  const relativePattern = /(?:dalam|tinggal|lagi)\s+(\d+)\s*(?:minit|minute|min|minit\s+lagi|minutes?\s+(?:left|from\s+now))/gi;
  const hasCurrentTimeMention = (() => {
    const currentMinStr = minute.toString().padStart(2, '0');
    const hr12 = hour % 12 === 0 ? 12 : hour % 12;
    return text.includes(hr12 + ':' + currentMinStr) || text.includes(hr12 + '.' + currentMinStr);
  })();

  if (hasCurrentTimeMention) {
    let relMatch;
    relativePattern.lastIndex = 0;
    while ((relMatch = relativePattern.exec(text)) !== null) {
      const minsOff = parseInt(relMatch[1], 10);
      if (minsOff >= 3) {
        console.log('[AntiHalluc] ⏰ Suspicious relative time: "' + relMatch[0] + '" near current time mention — may be hallucinated');
        replacements.push({
          index: relMatch.index,
          oldStr: relMatch[0],
          newStr: /\bminit\b/i.test(relMatch[0]) ? 'sekarang' : 'now',
        });
      }
    }
  }

  if (replacements.length === 0) return text;

  // Sort by index descending so we can replace from right to left
  replacements.sort((a, b) => b.index - a.index);

  let fixed = text;
  for (const r of replacements) {
    const before = fixed.substring(0, r.index);
    const after = fixed.substring(r.index + r.oldStr.length);
    fixed = before + r.newStr + after;
    console.log('[AntiHalluc] ⏰ Fixing hallucinated time: "' + r.oldStr + '" → "' + r.newStr + '" (actual=' + hour + ':' + minute.toString().padStart(2, '0') + ')');
  }

  console.log('[AntiHalluc] ⏰ Corrected message:', fixed.slice(0, 200));
  return fixed;
}

module.exports = { fixHallucinatedGreeting, fixHallucinatedTime };
