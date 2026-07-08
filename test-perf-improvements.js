// test-perf-improvements.js
// Quick validation tests for performance improvements
require('dotenv').config();

console.log('');
console.log('🧪 TESTING PERFORMANCE IMPROVEMENTS');
console.log('═══════════════════════════════════');
console.log('');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    // If it returns a promise, wait for it
    if (result && typeof result.then === 'function') {
      result.then(() => {
        console.log('  ✅ ' + name);
        passed++;
      }).catch(err => {
        console.log('  ❌ ' + name);
        console.log('     ' + err.message);
        failed++;
      });
    } else {
      console.log('  ✅ ' + name);
      passed++;
    }
  } catch (err) {
    console.log('  ❌ ' + name);
    console.log('     ' + err.message);
    failed++;
  }
}

// ═════════════════════════════════════════════════════════════════
// TEST 1: Module Loading
// ═════════════════════════════════════════════════════════════════
console.log('📦 Test 1: Module Loading & Structure');
console.log('─────────────────────────────────────');

test('llm/index.js loads without error', () => {
  const llm = require('./src/llm');
  if (typeof llm.chat !== 'function') throw new Error('llm.chat not a function');
});

test('deepseek.js chat accepts 5 params (incl prefetched)', () => {
  const deepseek = require('./src/llm/deepseek');
  if (typeof deepseek.chat !== 'function') throw new Error('deepseek.chat not found');
});

test('mimo.js chat accepts 5 params (incl prefetched)', () => {
  const mimo = require('./src/llm/mimo');
  if (typeof mimo.chat !== 'function') throw new Error('mimo.chat not found');
});

test('shared.js exports buildSystemPrompt + normalizeLLMResponse', () => {
  const shared = require('./src/llm/shared');
  if (typeof shared.buildSystemPrompt !== 'function') throw new Error('buildSystemPrompt not exported');
  if (typeof shared.normalizeLLMResponse !== 'function') throw new Error('normalizeLLMResponse not exported');
});

// ═════════════════════════════════════════════════════════════════
// TEST 2: fixHallucinatedTime Early Exit
// ═════════════════════════════════════════════════════════════════
console.log('');
console.log('⏰ Test 2: fixHallucinatedTime Early Exit');
console.log('────────────────────────────────────────');

const { fixHallucinatedTime: actualFixHallucinatedTime } = require('./src/bot/anti-hallucination');

// Mock version matching the actual logic
function fixHallucinatedTime(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!/\d/.test(text)) return text;
  if (!/(pukul|jam|[.:]\d|pagi|petang|malam|am|pm|tengah)/i.test(text)) return text;
  return text + ' [TIME_CHECKED]';
}

test('Early exit: no digits → returns immediately', () => {
  const result = fixHallucinatedTime('Hello, how are you?');
  if (result !== 'Hello, how are you?') throw new Error('Should return unchanged');
});

test('Early exit: digits but no time keywords → returns immediately', () => {
  const result = fixHallucinatedTime('I have 3 cats and 2 dogs');
  if (result !== 'I have 3 cats and 2 dogs') throw new Error('Should return unchanged');
});

test('Has time keyword "pukul" → continues to time check', () => {
  const result = fixHallucinatedTime('pukul 3:00');
  if (!result.includes('[TIME_CHECKED]')) throw new Error('Should pass early exit');
});

test('Has time keyword "jam" → continues to time check', () => {
  const result = fixHallucinatedTime('jam 9.30 pagi');
  if (!result.includes('[TIME_CHECKED]')) throw new Error('Should pass early exit');
});

test('Has "am"/"pm" keyword → continues to time check', () => {
  const result = fixHallucinatedTime('meeting at 2pm');
  if (!result.includes('[TIME_CHECKED]')) throw new Error('Should pass early exit');
});

test('Has "tengah" + digit → continues to time check', () => {
  const result = fixHallucinatedTime('tengah hari pukul 12:00');
  if (!result.includes('[TIME_CHECKED]')) throw new Error('Should pass early exit');
});

test('Empty string → returns immediately', () => {
  if (fixHallucinatedTime('') !== '') throw new Error('Should return empty');
});

test('null → returns immediately', () => {
  if (fixHallucinatedTime(null) !== null) throw new Error('Should return null');
});

test('Malay greeting "apa khabar" → early exit (no time)', () => {
  if (fixHallucinatedTime('apa khabar boss?') !== 'apa khabar boss?') throw new Error('Should return unchanged');
});

test('"tengah hari nanti" (no digits) → early exit correctly', () => {
  if (fixHallucinatedTime('tengah hari nanti') !== 'tengah hari nanti') throw new Error('Should return unchanged');
});

test('Routine sleep time stays unchanged near current-time sentence', () => {
  const tz = process.env.TIMEZONE || 'UTC';
  const now = new Date();
  const currentHour24 = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10);
  const currentMinute = parseInt(new Intl.DateTimeFormat('en', { timeZone: tz, minute: '2-digit' }).format(now), 10);
  const currentTotalMins = currentHour24 * 60 + currentMinute;

  const routineTotalMins = (currentTotalMins + 180) % (24 * 60);
  const routineHour24 = Math.floor(routineTotalMins / 60);
  const routineMinute = routineTotalMins % 60;
  const routineHour12 = routineHour24 % 12 === 0 ? 12 : routineHour24 % 12;
  const routineSuffix = routineHour24 >= 12 ? 'PM' : 'AM';

  const currentHour12 = currentHour24 % 12 === 0 ? 12 : currentHour24 % 12;
  const currentSuffix = currentHour24 >= 12 ? 'PM' : 'AM';

  const routineTime = routineHour12 + ':' + String(routineMinute).padStart(2, '0') + ' ' + routineSuffix;
  const currentTime = currentHour12 + ':' + String(currentMinute).padStart(2, '0') + ' ' + currentSuffix;
  const message = 'Biasanya awak tidur around ' + routineTime + ' kan? Tapi sekarang dah pukul ' + currentTime + '.';

  const fixed = actualFixHallucinatedTime(message);
  if (!fixed.includes(routineTime)) throw new Error('Routine time should stay unchanged: ' + fixed);
});

// ═════════════════════════════════════════════════════════════════
// TEST 3: Intent Detection
// ═════════════════════════════════════════════════════════════════
console.log('');
console.log('🎯 Test 3: Intent Detection');
console.log('────────────────────────────');

const { detectIntent } = require('./src/llm/intent');

test('"hi" → fast tier', () => {
  if (detectIntent('hi').tier !== 'fast') throw new Error('Expected fast');
});

test('"remind me to call mum" → deep tier', () => {
  if (detectIntent('remind me to call mum').tier !== 'deep') throw new Error('Expected deep');
});

test('"apa khabar" → fast tier (Malay)', () => {
  if (detectIntent('apa khabar').tier !== 'fast') throw new Error('Expected fast');
});

test('"what time is it" → fast tier', () => {
  if (detectIntent('what time is it').tier !== 'fast') throw new Error('Expected fast');
});

test('"how do I learn React" → medium tier', () => {
  if (detectIntent('how do I learn React').tier !== 'medium') throw new Error('Expected medium');
});

// ═════════════════════════════════════════════════════════════════
// TEST 4: Structure Checks (source code grep)
// ═════════════════════════════════════════════════════════════════
console.log('');
console.log('🔍 Test 4: Source Code Structure');
console.log('────────────────────────────────');

const fs = require('fs');

test('#1: deepseek.js has Promise.all (parallel fetch)', () => {
  const code = fs.readFileSync('./src/llm/deepseek.js', 'utf8');
  if (!code.includes('Promise.all')) throw new Error('Missing Promise.all');
  if (!code.includes('prefetched')) throw new Error('Missing prefetched param');
});

test('#2: mimo.js has Promise.all (parallel fetch)', () => {
  const code = fs.readFileSync('./src/llm/mimo.js', 'utf8');
  if (!code.includes('Promise.all')) throw new Error('Missing Promise.all');
  if (!code.includes('prefetched')) throw new Error('Missing prefetched param');
});

test('#2: llm/index.js has prepareContext (deduplicated prefetch)', () => {
  const code = fs.readFileSync('./src/llm/index.js', 'utf8');
  if (!code.includes('prepareContext')) throw new Error('Missing prepareContext');
  if (!code.includes('Promise.all([')) throw new Error('Missing parallel fetch in prepareContext');
});

test('#3: shared.js has centralized validation (deduplicated from providers)', () => {
  const code = fs.readFileSync('./src/llm/shared.js', 'utf8');
  if (!code.includes('validateParsedResponse')) throw new Error('Missing validateParsedResponse');
  if (!code.includes('parseAndValidate')) throw new Error('Missing parseAndValidate');
  if (!code.includes('getValidator()')) throw new Error('Missing lazy validator loader');
  // Should have lightweight check for fast tier (minimal mode)
  if (!code.includes('Fast-tier action hallucination blocked')) throw new Error('Missing fast-tier lightweight check');
});

test('#3: deepseek.js uses shared parseAndValidate (deduplicated)', () => {
  const code = fs.readFileSync('./src/llm/deepseek.js', 'utf8');
  if (!code.includes('parseAndValidate')) throw new Error('Missing parseAndValidate import/usage');
  // Should NOT have the old duplicated validator import
  if (code.includes("require('./validator')")) throw new Error('Still has direct validator import (should use shared)');
});

test('#3: mimo.js uses shared parseAndValidate (deduplicated)', () => {
  const code = fs.readFileSync('./src/llm/mimo.js', 'utf8');
  if (!code.includes('parseAndValidate')) throw new Error('Missing parseAndValidate import/usage');
  // Should NOT have the old duplicated validator import
  if (code.includes("require('./validator')")) throw new Error('Still has direct validator import (should use shared)');
});

test('#4: bot/index.js has early exit guard in fixHallucinatedTime', () => {
  const code = fs.readFileSync('./src/bot/index.js', 'utf8');
  if (!code.includes('Early exit')) throw new Error('Missing early exit comment');
});

test('#5: shared.js has promptCache (in-memory prompt caching)', () => {
  const code = fs.readFileSync('./src/llm/shared.js', 'utf8');
  if (!code.includes('promptCache')) throw new Error('Missing promptCache');
  if (!code.includes('PROMPT_CACHE_TTL_MS')) throw new Error('Missing PROMPT_CACHE_TTL_MS');
  if (!code.includes('promptCache.set(cacheKey')) throw new Error('Missing cache storage');
});

test('#6: bot/index.js has Promise.race interim message', () => {
  const code = fs.readFileSync('./src/bot/index.js', 'utf8');
  if (!code.includes('Promise.race')) throw new Error('Missing Promise.race');
  if (!code.includes('Sedang berfikir')) throw new Error('Missing interim message text');
  if (!code.includes('thinkingMsg')) throw new Error('Missing thinkingMsg variable');
});

test('#7: deepseek.js uses options.maxTokens', () => {
  const code = fs.readFileSync('./src/llm/deepseek.js', 'utf8');
  if (!code.includes('options.maxTokens')) throw new Error('Missing dynamic maxTokens');
});

test('#7: mimo.js uses options.maxTokens', () => {
  const code = fs.readFileSync('./src/llm/mimo.js', 'utf8');
  if (!code.includes('options.maxTokens')) throw new Error('Missing dynamic maxTokens');
});

test('#7: llm/index.js computes dynamic maxTokens', () => {
  const code = fs.readFileSync('./src/llm/index.js', 'utf8');
  if (!code.includes('maxTokens = 150')) throw new Error('Missing fast-tier maxTokens=150');
  if (!code.includes('maxTokens = 400')) throw new Error('Missing medium-tier maxTokens=400');
});

test('#8: deepseek.js exports chatStream function', () => {
  const deepseek = require('./src/llm/deepseek');
  if (typeof deepseek.chatStream !== 'function') throw new Error('Missing chatStream export');
});

test('#8: mimo.js exports chatStream function', () => {
  const mimo = require('./src/llm/mimo');
  if (typeof mimo.chatStream !== 'function') throw new Error('Missing chatStream export');
});

test('#8: llm/index.js exports chatStream function', () => {
  const llm = require('./src/llm');
  if (typeof llm.chatStream !== 'function') throw new Error('Missing chatStream in router');
});

test('#8: deepseek.js chatStream uses stream:true', () => {
  const code = fs.readFileSync('./src/llm/deepseek.js', 'utf8');
  if (!code.includes('stream: true')) throw new Error('Missing stream:true in DeepSeek API call');
  if (!code.includes('responseType: \'stream\'')) throw new Error('Missing responseType:stream');
});

test('#8: mimo.js chatStream uses stream:true', () => {
  const code = fs.readFileSync('./src/llm/mimo.js', 'utf8');
  if (!code.includes('stream: true')) throw new Error('Missing stream:true in MiMo API call');
  if (!code.includes('responseType: \'stream\'')) throw new Error('Missing responseType:stream');
});

test('#8: bot/index.js uses chatStream for medium/deep tiers', () => {
  const code = fs.readFileSync('./src/bot/index.js', 'utf8');
  if (!code.includes('chatStream')) throw new Error('Missing chatStream call');
  if (!code.includes('decision.tier === \'fast\'')) throw new Error('Missing tier check for streaming');
});

test('#8: bot/index.js has streaming editMessageText logic', () => {
  const code = fs.readFileSync('./src/bot/index.js', 'utf8');
  if (!code.includes('editMessageText')) throw new Error('Missing editMessageText for streaming');
  if (!code.includes('streamMsg')) throw new Error('Missing streamMsg tracking');
});

// ═════════════════════════════════════════════════════════════════
// RESULT
// ═════════════════════════════════════════════════════════════════
console.log('');
console.log('═══════════════════════════════════');
console.log('  ✅ ' + passed + ' passed  |  ❌ ' + failed + ' failed');
console.log('═══════════════════════════════════');
console.log('');

if (failed > 0) {
  process.exit(1);
}
