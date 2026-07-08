// src/executive/intent-engine.js
// ── Advanced Intent Detection Engine ───────────────────────────────────────
// Fasa 1: More sophisticated than simple regex matching.
// Uses layered detection: fast keyword → context-aware → confidence scoring.
//
// New capabilities:
//   - Confidence scoring (0.0-1.0) for every classification
//   - Context-aware escalation (previous messages influence intent)
//   - Sub-intent classification (what TYPE of task?)
//   - Mood/sentiment detection
//   - Urgency detection
//   - Language mix detection (BM/EN/rojak)

// ── Intent Categories ──────────────────────────────────────────────────────
const INTENT_CATEGORIES = {
  GREETING: 'greeting',
  QUESTION_FACT: 'question_fact',       // "What time is it?" — factual
  QUESTION_OPINION: 'question_opinion', // "What do you think about X?"
  QUESTION_HOWTO: 'question_howto',     // "How do I do X?"
  TASK_REMINDER: 'task_reminder',       // Create/manage reminders
  TASK_EVENT: 'task_event',             // Create/manage calendar events
  TASK_NOTE: 'task_note',               // Save notes
  TASK_MEMORY: 'task_memory',           // Remember facts
  TASK_SEARCH: 'task_search',           // Search web
  TASK_PLANNING: 'task_planning',       // Multi-step planning
  TASK_GOAL: 'task_goal',              // Goal setting/tracking
  TASK_PROJECT: 'task_project',        // Project management
  CONVERSATION: 'conversation',         // Casual chat
  FEEDBACK: 'feedback',                // Praise/complaint about bot
  COMMAND_CONFIG: 'command_config',     // Bot configuration
  REFLECTION: 'reflection',            // Self-reflection request
  EMERGENCY: 'emergency',              // Urgent/important
  UNKNOWN: 'unknown',
};

// ── Fast Pattern Matchers ──────────────────────────────────────────────────
const FAST_PATTERNS = {
  greeting: [
    /^(hi|hello|hey|hai|helo|selamat\s*(pagi|petang|malam|tengahari)|assalam|salam|yo|sup|what's\s*up|wsup)\b/i,
    /^(apa\s*khabar|how\s*are\s*you|how's\s*it\s*going|howdy)\b/i,
    /^(ok|okay|baik|baiklah|alright|fine|bagus)\b/i,
  ],
  gratitude: [
    /^(thanks|thank\s*you|terima\s*kasih|tq|thx|ty|makasih|good\s*(job|bot)|nice|great|awesome|terbaik|power)\b/i,
  ],
  farewell: [
    /^(bye|goodbye|bai|jumpa|see\s*you|night|selamat\s*malam|good\s*night|babai|bye\s*bye)\b/i,
  ],
  timeQuery: [
    /^(pukul\s*berapa|jam\s*berapa|what\s*time|time\s*now|current\s*time|time\s*check)\b/i,
    /^(hari\s*apa|what\s*day|today\s*date|tarikh|hari\s*ni\s*apa)\b/i,
    /^(sekarang\s*(pukul|jam|hari|tarikh))\b/i,
  ],
  botIdentity: [
    /^(nama\s*(awak|ko|kau|bot)|what('?s| is) your name|who are you|siapa\s*(awak|ko|kau|nama))\b/i,
    /^(boleh\s*(buat|tolong)\s*apa|what can you do|apa\s*(function|fungsi|boleh\s*buat)|capabilities)\b/i,
  ],
};

const DEEP_PATTERNS = {
  reminder: [
    /ingatkan|remind(er)?|peringatan|notify|notification|alarm/i,
    /(set|buat|create|add|tambah)\s*(reminder|peringatan|alarm)/i,
  ],
  event: [
    /jadual|schedule|kalendar|calendar|event|temujanji|appointment/i,
    /(masuk|add|tambah)\s*(dalam|ke)\s*(kalendar|calendar|jadual|schedule)/i,
  ],
  note: [
    /(simpan|save|ingat|remember)\s*(nota|note|fact|fakta|info|maklumat)/i,
    /(tulis|catat|rekod|record)\s*(nota|note)/i,
  ],
  search: [
    /(cari|search|google)\s*(dalam|online|internet|google|web|berita|news|terkini|untuk|tentang|about|for)?/i,
    /(check|semak|checkkan)\s*(harga|price|news|berita|status)/i,
  ],
  planning: [
    /plan|rancang|planning|strategy|strategi|roadmap/i,
    /step|langkah|process|proses|workflow|tutorial|guide|panduan/i,
    /breakdown|pecahkan|bahagi\s*(task|kerja|tugas)/i,
  ],
  goal: [
    /goal|matlamat|target|sasaran|objective|objektif/i,
    /(nak\s*capai|nak\s*kejar|nak\s*achieve|want\s*to\s*achieve)/i,
    /(resolution|azam|tekad)/i,
  ],
  project: [
    /project|projek|sambung\s*(projek|kerja|task|buat)|continue/i,
    /(manage|urus)\s*(project|projek)/i,
  ],
  analysis: [
    /analisis|analisa|analy(s|z)e|breakdown|bandingkan|compare/i,
    /suggest|cadang|recommend|syor|nasihat\s*(apa|macam)/i,
    /patut\s*(ke|tak)|should\s*i|advisable|sesuai\s*ke|baik\s*mana|which\s*(is|one)/i,
  ],
  purchase: [
    /\b(beli|nak\s*beli|buy|purchase|membeli)\b/i,
    /berapa\s*(kos|harga|budget|cost|price)|estimate|anggar/i,
  ],
};

// ── BM Question Words (Kata Tanya) ─────────────────────────────────────────
// Item #1: BM question detection with suffix -ke? and -kah
const BM_QUESTION_PATTERNS = {
  what: /\b(apa|apakah|apa\s*(ni|tu|benda|hal))\b/i,
  who: /\b(siapa|siapakah|sape)\b/i,
  when: /\b(bila|bilakah|bile)\b/i,
  where: /\b(mana|kat\s*mana|di\s*mana|ke\s*mana|dari\s*mana|mane)\b/i,
  why: /\b(kenapa|mengapa|kenape|pasal\s*apa|sebab\s*apa|nape)\b/i,
  how: /\b(macam\s*mana|bagaimana|camne|macam\s*ne|cam\s*mana|how)\b/i,
  howMuch: /\b(berapa|brape|banyak\s*mana)\b/i,
  which: /\b(yang\s*mana|mane\s*satu|pilih\s*mana)\b/i,
  // -ke suffix questions
  suffixKe: /\b(boleh\s*ke|betul\s*ke|bagus\s*ke|patut\s*ke|elok\s*ke|ok\s*ke|boleh\s*tak|jadi\s*ke|sempat\s*ke|perlu\s*ke)\b/i,
  // -kah suffix questions
  suffixKah: /\b(adakah|bolehkah|perlukah|mestikah|wajarkah|benarkah|sudahkah|mungkinkah|haruskah)\b/i,
  // embedded question markers
  questionMarkers: /\b(tanya\s*sikit|nak\s*tanya|soalan|nak\s*tahu|bole\s*tanya|nak\s*check)\b/i,
};

// ── BM Slang/Colloquial (Bahasa Pasar) ────────────────────────────────────
// Item #2: Slang mapping for better keyword matching
const BM_SLANG_PATTERNS = /\b(nak|tak|kat|gi|tau|je|ni|tu|dorang|kitorang|diorang|korang|hang|demo|mike|kome|awak\s*semua|hangpa|depa|ceq|ambo|den|gue|gua|lu|elo|elo\s*elo|weh|wey|woi|doi|alahai|adoi|aiseh|aiseyman|alamak|ish|ishk|cis|ceh|eleh|amek|amboih|hisy)\b/i;

// ── BM Discourse Markers ───────────────────────────────────────────────────
// Item #3: Discourse markers that reveal intent
const DISCOURSE_MARKERS = {
  clarification: /\b(sebenarnya|sebenarnye|actually|truth\s*is|to\s*be\s*honest|honestly|aku\s*rasa|pada\s*pendapat|ikut\s*aku|bagi\s*aku)\b/i,
  explanation: /\b(macam\s*ni|macam\s*ne|camni|gini|begini|maksudnya|maksud\s*aku|ceritanya|cerita\s*die|story\s*die|ni\s*ha|macam\s*gini|ok\s*macam\s*ni)\b/i,
  surprise: /\b(eh|ehh|ehhh|alamak|ish|aiseh|wah|wow|woah|gila|gile|gila\s*babi|serious|serius|biar\s*betul|sumpah|sumpah\s*ke)\b/i,
  concern: /\b(alamak|adoi|adoiii|aiseyman|ish\s*ish|habis\s*la|habis\s*lah|matila|mati\s*la|habis\s*macam\s*tu|macam\s*mana\s*ni|camne\s*ni|gawat)\b/i,
  skepticism: /\b(ye\s*ke|betul\s*ke|sure\s*ke|serious|tipu|bohong|mengarut|mana\s*ada|tak\s*kan|takkan|mustahil|pelik|aneh)\b/i,
  followUp: /\b(habis\s*tu|pastu|lepas\s*tu|then|jadi|so|maksudnya|ertinya|maknanya|kiranya|kira|dalam\s*erti\s*kata\s*lain)\b/i,
  indifference: /\b(apa\s*apa\s*je|mana\s*mana|tak\s*kesah|tak\s*kesahlah|takpe|tak\s*pe|tak\s*apa|entah|entah\s*la|tak\s*tau\s*la|malas\s*nak\s*pikir|ikut\s*suka\s*hati|terserah)\b/i,
};

// ── BM Temporal Expressions ────────────────────────────────────────────────
// Item #4: Malay time expressions for better date/time parsing
const BM_TEMPORAL = {
  relativeDay: /\b(lusa|tulat|tubin|semalam|kelmarin|kelmarin\s*dulu|esok|besok|hari\s*ni|hari\s*esok)\b/i,
  relativeWeek: /\b(minggu\s*depan|minggu\s*lepas|minggu\s*ni|minggu\s*hadapan|hujung\s*minggu|weekend|weekend\s*ni)\b/i,
  relativeMonth: /\b(bulan\s*depan|bulan\s*lepas|bulan\s*ni|hujung\s*bulan|awal\s*bulan)\b/i,
  relativeYear: /\b(tahun\s*depan|tahun\s*lepas|tahun\s*ni|hujung\s*tahun)\b/i,
  timeOfDay: /\b(pagi\s*ni|petang\s*ni|malam\s*ni|tengah\s*hari\s*ni|esok\s*pagi|esok\s*petang|esok\s*malam|malam\s*esok)\b/i,
  relativeTime: /\b(kejap\s*lagi|sekejap\s*lagi|nanti|nanti\s*sikit|later|dalam\s*masa\s*terdekat|tak\s*lama\s*lagi|sebentar\s*lagi|sekejap|sebentar)\b/i,
  // Specific BM time phrases
  timePhrases: /\b(pukul\s*\d+|jam\s*\d+|kol\s*\d+|pukul\s*berapa|jam\s*berapa|kol\s*berapa)\b/i,
};

// ── BM Command/Action Verbs ────────────────────────────────────────────────
// Item #10: Malay imperative/request verbs
const BM_COMMAND_PATTERNS = {
  create: /\b(buatkan|buat\s*kan|settlekan|settle\s*kan|createkan|create\s*kan|hasilkan|sediakan|siapkan|generatekan)\b/i,
  manage: /\b(uruskan|urus\s*kan|handlekan|handle\s*kan|managekan|manage\s*kan|kendalikan|selenggara)\b/i,
  inform: /\b(bagitau|bagi\s*tau|bagi\s*tahu|beritahu|updatekan|update\s*kan|maklumkan|khabarkan|inform)\b/i,
  check: /\b(tengokkan|tengok\s*kan|checkkan|check\s*kan|semakkan|semak\s*kan|periksakan|lihatkan)\b/i,
  remind: /\b(remindkan|remind\s*kan|ingatkan|ingat\s*kan|peringatkan|notifykan|notify\s*kan)\b/i,
  search: /\b(carikan|cari\s*kan|searchkan|search\s*kan|googlekan|google\s*kan)\b/i,
  list: /\b(listkan|list\s*kan|senaraikan|tunjukkan|tunjuk\s*kan|bagi\s*list|bagi\s*senarai)\b/i,
  generalRequest: /\b(tolong\s*(buat|settle|urus|handle|bagi|check|tengok|cari|search|list|remind|ingat|update|simpan|tulis|catat))\b/i,
};

// ── BM Affirmation/Negation/Uncertainty Detection ──────────────────────────
// Item #11: Detect user agreement, disagreement, or uncertainty
const AFFIRMATION_PATTERNS = /\b(haah|ha'ah|ha\s*ah|betul|betul\s*tu|setuju|ok|okay|oke|boleh|jalan|jalan\s*terus|teruskan|go\s*ahead|sounds\s*good|bagus|baik|baiklah|yes|ye|ya|yup|yep)\b/i;

const NEGATION_PATTERNS_BM = /\b(bukan\s*ke|mana\s*ada|tak\s*mungkin|takkan|tipu|bohong|mengarut|tak\s*betul|salah|silap|tak\s*setuju|tak\s*boleh|jangan|no|tak\s*nak|tak\s*mahu|enggan|tolak)\b/i;

const UNCERTAINTY_PATTERNS = /\b(tak\s*sure|tak\s*pasti|maybe|mungkin|entah|entah\s*la|rasanya|rasa\s*macam|agaknya|agak\s*nya|kot|kot\s*la|tak\s*confirm|belum\s*pasti|bergantung|tengok\s*dulu|tengok\s*macam\s*mana)\b/i;

// ── BM Politeness/Formality Level Detection ────────────────────────────────
// Item #8: Detect formal vs informal register
const FORMALITY_PATTERNS = {
  formal: /\b(saya|anda|bolehkah|tolonglah|silakan|harap|mohon|diharap|diminta|sekiranya|kiranya|dipersilakan|jemput|jemputlah)\b/i,
  informal: /\b(aku|kau|ko|awak|boleh\s*tak|tolong|weh|wey|woi|bro|sis|geng|kawan|member|mate|buddy|fam)\b/i,
  veryInformal: /\b(gua|gue|lu|elo|do|hang|demo|mike|kome|ceq|ambo|den)\b/i,
};

// ── Mood/Sentiment Indicators (Enhanced BM v2) ─────────────────────────────
const MOOD_PATTERNS = {
  happy: [/seronok|happy|gembira|best|bestnya|nice|bagusnya|excited|teruja|yay|syok|syoknya|best\s*gila|puas\s*hati|berbaloi|best\s*gile|best\s*do|best\s*woh|bahagia/i],
  sad: [/sedih|sad|down|murung|kecewa|disappointed|frustrated|frust|kecewa\s*sangat|down\s*gila|sayu|pilu|sebak|sedih\s*gila|sedih\s*do/i],
  angry: [/marah|angry|geram|bengang|annoyed|menyampah|fed\s*up|menyampah\s*gila|panas\s*hati|naik\s*darah|bengang\s*gila|menyampah\s*do|sakit\s*hati|geramnya/i],
  tired: [/penat|letih|tired|exhausted|ngantuk|sleepy|tak\s*larat|lesu|tak\s*bertenaga|drained|burnout|burn\s*out|penat\s*gila|letih\s*do|penatnya/i],
  anxious: [/risau|bimbang|anxious|worried|nervous|gugup|scared|takut|gelisah|resah|cemas|panik|panic|risau\s*gila|bimbang\s*do|takutnya/i],
  motivated: [/semangat|motivated|bersemangat|pumped|ready|bersedia|jom|on\s*fire|let's\s*go|letsgo|power|powerr|semangat\s*do|power\s*gila|jom\s*boleh/i],
  confused: [/confused|keliru|tak\s*faham|don't\s*understand|confusing|pening|blur|tak\s*pasti|serba\s*salah|bingung|pening\s*gila|blur\s*do|tak\s*faham\s*do/i],
  bored: [/bosan|boring|bored|tak\s*tahu\s*nak\s*buat\s*apa|nothing\s*to\s*do|sunyi|sepi|bosan\s*gila|bosan\s*do|takde\s*benda\s*nak\s*buat|mati\s*kutu/i],
  grateful: [/bersyukur|grateful|thankful|alhamdulillah|syukur|terharu|touched|appreciate|hargai|terima\s*kasih\s*banyak|bersyukur\s*sangat/i],
  // Item #6: New BM mood categories
  stressed: [/stress|stres|tertekan|tekanan|pressure|overwhelmed|semak|serabut|pening\s*kepala|tak\s*larat\s*dah|give\s*up|menyerah|putus\s*asa/i],
  lonely: [/sunyi|sepi|lonely|alone|sorang|keseorangan|takde\s*kawan|rindu|rindu\s*gila|rindu\s*do/i],
  proud: [/bangga|proud|berjaya|success|berjaya\s*do|akhirnya|yes|akhirnya\s*boleh|aku\s*boleh/i],
  jealous: [/cemburu|jealous|iri\s*hati|dengki|tak\s*puas\s*hati|orang\s*dapat/i],
  relieved: [/lega|lapang|tenang|relieved|phew|fuh|nasib\s*baik|syukur\s*la|lega\s*do|akhirnya\s*selesai/i],
  curious: [/curious|nak\s*tahu|curious\s*gila|apa\s*benda|apa\s*tu|apa\s*ni|cerita\s*sikit|share\s*sikit/i],
};

// ── Negation words (for negation-aware mood detection) ─────────────────────
// "tak sedih" = NOT sad, "bukan marah" = NOT angry, "kurang happy" = less happy
const NEGATION_WORDS = /\b(tak|tidak|bukan|kurang|bukanlah|takde|tiada|bukan\s*nya)\s+/i;

// ── Urgency Indicators (Enhanced BM v2) ────────────────────────────────────
const URGENCY_PATTERNS = [
  /\b(urgent|kecemasan|emergency|segera|asap|cepat|now|sekarang\s*juga)\b/i,
  /\b(penting|critical|kritikal|must|mesti|wajib|perlu\s*cepat|perlu\s*segera)\b/i,
  /\!{2,}/,
  /\b(HELP|TOLONG|EMERGENCY|BAKAR|KEBAKARAN|KECEMASAN|KEMALANGAN|PENYAKIT|SAKIT\s*TERUK|NAK\s*MATI)\b/,
  /\b(cepat\s*cepat|lekas|sekarang\s*ni|right\s*now|stat|immediately|urgent\s*gila|urgent\s*do|penting\s*gila|penting\s*ni|cepat\s*sikit|cepat\s*sikit\s*boleh)\b/i,
  /\b(kalau\s*lambat|kalau\s*tak\s*sekarang|nanti\s*terlepas|dah\s*nak\s*due|dah\s*nak\s*mati|dah\s*tak\s*larat)\b/i,
];

// ── Context-Aware Escalation ────────────────────────────────────────────────
// Words that, when repeated from previous messages, suggest task continuation
const CONTINUATION_SIGNALS = [
  'lagi', 'also', 'juga', 'then', 'lepas\s*tu', 'kemudian',
  'next', 'seterusnya', 'continue', 'sambung', 'and\s*also',
  'one\s*more', 'satu\s*lagi', 'add\s*on', 'tambah\s*lagi',
  'pastu', 'habis\s*tu', 'lepas\s*ni', 'then\s*apa', 'so',
  'jadi\s*lepas\s*tu', 'ok\s*next', 'next\s*step', 'apa\s*lagi',
  'ada\s*lagi', 'nak\s*tambah', 'tambah\s*sikit', 'satu\s*lagi\s*benda',
];

// ── Confidence Scoring Engine ───────────────────────────────────────────────

/**
 * Score a match against a set of patterns with weights.
 * @param {string} text - user message
 * @param {Array<RegExp|{pattern:RegExp, weight:number}>} patterns
 * @returns {number} confidence 0.0-1.0
 */
function scorePatterns(text, patterns) {
  if (!patterns || patterns.length === 0) return 0;

  let totalWeight = 0;
  let matchWeight = 0;

  for (const p of patterns) {
    const pattern = p.pattern || p;
    const weight = p.weight || 1.0;
    totalWeight += weight;

    if (pattern.test(text)) {
      matchWeight += weight;
    }
  }

  return totalWeight > 0 ? matchWeight / totalWeight : 0;
}

/**
 * Detect mood from text with negation awareness (Item #9).
 * "tak sedih" ≠ sad mood, "bukan marah" ≠ angry.
 * @param {string} text
 * @returns {{mood: string, confidence: number}}
 */
function detectMood(text) {
  let bestMood = 'neutral';
  let bestConf = 0;

  // Check if the text has a negation prefix near mood words
  const hasNegation = NEGATION_WORDS.test(text);

  for (const [mood, patterns] of Object.entries(MOOD_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        // ── Negation handling ────────────────────────────────────────────
        // If a negation word precedes the mood keyword, reduce confidence
        let conf = 0.6;
        if (hasNegation) {
          // Check if negation is near this specific match
          const matchPos = text.search(pattern);
          const beforeMatch = text.substring(Math.max(0, matchPos - 15), matchPos);
          if (NEGATION_WORDS.test(beforeMatch)) {
            conf = 0.15; // Strong negation → weak signal
          }
        }

        if (conf > bestConf) {
          bestMood = mood;
          bestConf = conf;
        }
      }
    }
  }

  return { mood: bestMood, confidence: bestConf };
}

/**
 * Detect urgency level.
 * @param {string} text
 * @returns {{isUrgent: boolean, confidence: number}}
 */
function detectUrgency(text) {
  let matchCount = 0;
  let totalConf = 0;

  for (const pattern of URGENCY_PATTERNS) {
    if (pattern.test(text)) {
      matchCount++;
      totalConf += 0.7;
    }
  }

  // Multiple exclamation marks is a weaker signal
  if (/\!{3,}/.test(text)) {
    totalConf += 0.3;
  }

  return {
    isUrgent: matchCount > 0,
    confidence: Math.min(1.0, totalConf),
  };
}

/**
 * Detect language mix (BM, EN, Rojak).
 * Enhanced with BM slang detection (Item #2).
 * @param {string} text
 * @returns {{language: 'bm'|'en'|'rojak', confidence: number}}
 */
function detectLanguage(text) {
  const bmWords = /\b(saya|aku|awak|kau|dia|kita|kami|mereka|ini|itu|dan|atau|tapi|tetapi|yang|dengan|untuk|pada|dari|ke|di|sebab|kerana|boleh|nak|mahu|tahu|faham|bagi|ambil|buat|pergi|datang|ada|tiada|tak|bukan|ya|sangat|juga|pun|lah|kah|tah|ni|tu|je|kat|ni|dah|belum|akan|sedang|telah|masih|baru|lama|cepat|lambat|besar|kecil|baik|buruk|cantik|hensem|mahal|murah|tau|gi|dorang|kitorang|korang|hang|demo|depa|gua|lu|elo|weh|habis|pastu|macam|gitu|gini|camtu|camni|sikit|banyak|sangat|gila|do|pon|kalo|kalau|punya|punye|pegi|amik|bg|smpi|sampai|tp|nk|dh|xde|ade)\b/gi;
  const enWords = /\b(i|you|he|she|it|we|they|this|that|and|or|but|because|with|for|from|to|at|in|on|can|will|would|should|could|want|need|know|understand|get|take|make|go|come|have|has|had|is|are|was|were|not|yes|no|very|also|too|already|yet|still|just|new|old|big|small|good|bad|expensive|cheap)\b/gi;

  const bmMatches = (text.match(bmWords) || []).length;
  const enMatches = (text.match(enWords) || []).length;

  // Bonus: BM slang patterns boost BM word count
  const slangMatches = (text.match(BM_SLANG_PATTERNS) || []).length;
  const totalBmWeight = bmMatches + (slangMatches * 1.5);

  const total = totalBmWeight + enMatches;

  if (total === 0) return { language: 'en', confidence: 0.5 };

  const bmRatio = totalBmWeight / total;

  if (bmRatio > 0.75) return { language: 'bm', confidence: bmRatio };
  if (bmRatio < 0.2) return { language: 'en', confidence: 1 - bmRatio };
  return { language: 'rojak', confidence: Math.abs(bmRatio - 0.5) * 2 };
}

/**
 * Detect politeness/formality level of BM text (Item #8).
 * @param {string} text
 * @returns {{level: 'formal'|'informal'|'very_informal'|'neutral', confidence: number}}
 */
function detectFormality(text) {
  const formalCount = (text.match(FORMALITY_PATTERNS.formal) || []).length;
  const informalCount = (text.match(FORMALITY_PATTERNS.informal) || []).length;
  const veryInformalCount = (text.match(FORMALITY_PATTERNS.veryInformal) || []).length;

  const total = formalCount + informalCount + veryInformalCount;
  if (total === 0) return { level: 'neutral', confidence: 0.5 };

  if (veryInformalCount > formalCount && veryInformalCount > informalCount) {
    return { level: 'very_informal', confidence: veryInformalCount / total };
  }
  if (informalCount > formalCount) {
    return { level: 'informal', confidence: informalCount / total };
  }
  if (formalCount > 0) {
    return { level: 'formal', confidence: formalCount / total };
  }
  return { level: 'neutral', confidence: 0.5 };
}

/**
 * Detect affirmation, negation, or uncertainty in BM text (Item #11).
 * @param {string} text
 * @returns {{type: 'affirmative'|'negative'|'uncertain'|'neutral', confidence: number}}
 */
function detectAffirmation(text) {
  const affirmMatch = AFFIRMATION_PATTERNS.test(text);
  const negateMatch = NEGATION_PATTERNS_BM.test(text);
  const uncertainMatch = UNCERTAINTY_PATTERNS.test(text);

  if (affirmMatch && !negateMatch && !uncertainMatch) {
    return { type: 'affirmative', confidence: 0.8 };
  }
  if (negateMatch && !affirmMatch) {
    return { type: 'negative', confidence: 0.8 };
  }
  if (uncertainMatch) {
    return { type: 'uncertain', confidence: 0.7 };
  }
  return { type: 'neutral', confidence: 0.5 };
}

/**
 * Detect BM discourse markers and their implied intent (Item #3).
 * @param {string} text
 * @returns {{marker: string|null, category: string|null}}
 */
function detectDiscourseMarker(text) {
  for (const [type, pattern] of Object.entries(DISCOURSE_MARKERS)) {
    if (pattern.test(text)) {
      return { marker: type, category: type };
    }
  }
  return { marker: null, category: null };
}

/**
 * Detect BM temporal expressions for better time-sensitive intent (Item #4).
 * @param {string} text
 * @returns {{hasTemporal: boolean, types: string[]}}
 */
function detectTemporal(text) {
  const types = [];
  for (const [type, pattern] of Object.entries(BM_TEMPORAL)) {
    if (pattern.test(text)) {
      types.push(type);
    }
  }
  return { hasTemporal: types.length > 0, types };
}

/**
 * Detect BM command/action verbs for task intent (Item #10).
 * @param {string} text
 * @returns {{hasCommand: boolean, commandTypes: string[]}}
 */
function detectBMCommands(text) {
  const cmdTypes = [];
  for (const [type, pattern] of Object.entries(BM_COMMAND_PATTERNS)) {
    if (pattern.test(text)) {
      cmdTypes.push(type);
    }
  }
  return { hasCommand: cmdTypes.length > 0, commandTypes: cmdTypes };
}

// ── Main Intent Detection ──────────────────────────────────────────────────

/**
 * Advanced intent detection with confidence scoring, mood, urgency, 
 * and context-aware escalation.
 * 
 * @param {string} text - user message
 * @param {object} [context] - optional context from previous messages
 * @param {Array} [context.recentMessages] - last few message texts
 * @param {object} [context.workingMemory] - current working memory state
 * @returns {{
 *   tier: 'fast'|'medium'|'deep',
 *   category: string,
 *   subCategory: string,
 *   confidence: number,
 *   mood: string,
 *   moodConfidence: number,
 *   isUrgent: boolean,
 *   urgencyConfidence: number,
 *   language: string,
 *   reason: string,
 *   needsEscalation: boolean,
 *   escalationReason: string
 * }}
 */
function detectIntentAdvanced(text, context = {}) {
  const lower = text.toLowerCase().trim();
  const wordCount = lower.split(/\s+/).length;
  const questionCount = (lower.match(/\?/g) || []).length;

  // ── Step 1: Fast pattern matching ─────────────────────────────────────
  let category = INTENT_CATEGORIES.UNKNOWN;
  let confidence = 0.5;
  let reason = '';

  // Check greetings
  for (const pattern of FAST_PATTERNS.greeting) {
    if (pattern.test(lower)) {
      category = INTENT_CATEGORIES.GREETING;
      confidence = 0.95;
      reason = 'greeting detected';
      break;
    }
  }

  // Check gratitude
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    for (const pattern of FAST_PATTERNS.gratitude) {
      if (pattern.test(lower)) {
        category = INTENT_CATEGORIES.FEEDBACK;
        confidence = 0.9;
        reason = 'gratitude/feedback';
        break;
      }
    }
  }

  // Check farewell
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    for (const pattern of FAST_PATTERNS.farewell) {
      if (pattern.test(lower)) {
        category = INTENT_CATEGORIES.GREETING;
        confidence = 0.95;
        reason = 'farewell';
        break;
      }
    }
  }

  // Check time queries
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    for (const pattern of FAST_PATTERNS.timeQuery) {
      if (pattern.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_FACT;
        confidence = 0.95;
        reason = 'time/date query';
        break;
      }
    }
  }

  // Check bot identity
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    for (const pattern of FAST_PATTERNS.botIdentity) {
      if (pattern.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_FACT;
        confidence = 0.9;
        reason = 'bot identity question';
        break;
      }
    }
  }

  // ── Step 2: Deep pattern matching ─────────────────────────────────────
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    const deepChecks = [
      { patterns: DEEP_PATTERNS.reminder, category: INTENT_CATEGORIES.TASK_REMINDER },
      { patterns: DEEP_PATTERNS.event, category: INTENT_CATEGORIES.TASK_EVENT },
      { patterns: DEEP_PATTERNS.note, category: INTENT_CATEGORIES.TASK_NOTE },
      { patterns: DEEP_PATTERNS.search, category: INTENT_CATEGORIES.TASK_SEARCH },
      { patterns: DEEP_PATTERNS.planning, category: INTENT_CATEGORIES.TASK_PLANNING },
      { patterns: DEEP_PATTERNS.goal, category: INTENT_CATEGORIES.TASK_GOAL },
      { patterns: DEEP_PATTERNS.project, category: INTENT_CATEGORIES.TASK_PROJECT },
      { patterns: DEEP_PATTERNS.analysis, category: INTENT_CATEGORIES.TASK_PLANNING },
      { patterns: DEEP_PATTERNS.purchase, category: INTENT_CATEGORIES.TASK_PLANNING },
    ];

    for (const check of deepChecks) {
      for (const pattern of check.patterns) {
        if (pattern.test(lower)) {
          category = check.category;
          confidence = 0.85;
          reason = 'deep pattern: ' + check.category;
          break;
        }
      }
      if (category !== INTENT_CATEGORIES.UNKNOWN) break;
    }
  }

  // ── Step 3: Heuristic detection (Enhanced BM v2) ──────────────────────
  if (category === INTENT_CATEGORIES.UNKNOWN) {
    // ── BM Question Word Detection (Item #1) ────────────────────────────
    const hasBMQuestion = Object.values(BM_QUESTION_PATTERNS).some(p => p.test(lower));
    const hasQuestionMark = questionCount >= 1;

    // ── BM Command Detection (Item #10) ──────────────────────────────────
    const { hasCommand, commandTypes } = detectBMCommands(lower);

    // ── BM Discourse Marker Detection (Item #3) ──────────────────────────
    const { marker: discourseType } = detectDiscourseMarker(lower);

    // Question detection (English + BM questions)
    if (hasQuestionMark || hasBMQuestion) {
      const howToPatterns = /how\s*(to|do|can|should|could)|macam\s*mana|bagaimana|cara\s*(nak|untuk|buat)|camne|macam\s*ne|cam\s*mana/i;
      const opinionPatterns = /what\s*do\s*you\s*think|pendapat|opinion|what('?s| is) your|apa\s*pendapat|pendapat\s*(awak|ko|kau|hang)|apa\s*(awak|ko|kau|hang)\s*rasa/i;

      if (howToPatterns.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_HOWTO;
        confidence = 0.8;
        reason = 'how-to question';
      } else if (opinionPatterns.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_OPINION;
        confidence = 0.75;
        reason = 'opinion question';
      } else if (BM_QUESTION_PATTERNS.suffixKe.test(lower) || BM_QUESTION_PATTERNS.suffixKah.test(lower)) {
        // -ke / -kah suffix questions are typically yes/no or opinion
        category = INTENT_CATEGORIES.QUESTION_OPINION;
        confidence = 0.75;
        reason = 'BM -ke/-kah question';
      } else if (BM_QUESTION_PATTERNS.questionMarkers.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_FACT;
        confidence = 0.75;
        reason = 'BM question marker';
      } else if (BM_QUESTION_PATTERNS.why.test(lower)) {
        category = INTENT_CATEGORIES.QUESTION_FACT;
        confidence = 0.8;
        reason = 'BM why question';
      } else {
        category = INTENT_CATEGORIES.QUESTION_FACT;
        confidence = 0.7;
        reason = 'general question';
      }
    }
    // BM command/action verbs → task intent
    else if (hasCommand) {
      if (commandTypes.includes('remind')) {
        category = INTENT_CATEGORIES.TASK_REMINDER;
        confidence = 0.85;
        reason = 'BM remind command';
      } else if (commandTypes.includes('search')) {
        category = INTENT_CATEGORIES.TASK_SEARCH;
        confidence = 0.85;
        reason = 'BM search command';
      } else if (commandTypes.includes('create') || commandTypes.includes('inform')) {
        category = INTENT_CATEGORIES.TASK_NOTE;
        confidence = 0.8;
        reason = 'BM create/inform command';
      } else if (commandTypes.includes('manage')) {
        category = INTENT_CATEGORIES.TASK_PROJECT;
        confidence = 0.8;
        reason = 'BM manage command';
      } else if (commandTypes.includes('list')) {
        category = INTENT_CATEGORIES.TASK_SEARCH;
        confidence = 0.75;
        reason = 'BM list command';
      } else if (commandTypes.includes('generalRequest')) {
        category = INTENT_CATEGORIES.TASK_PLANNING;
        confidence = 0.75;
        reason = 'BM general request command';
      }
    }
    // BM Discourse marker signals
    else if (discourseType === 'clarification' || discourseType === 'explanation') {
      category = INTENT_CATEGORIES.CONVERSATION;
      confidence = 0.65;
      reason = 'BM discourse: ' + discourseType;
    } else if (discourseType === 'skepticism') {
      category = INTENT_CATEGORIES.QUESTION_OPINION;
      confidence = 0.65;
      reason = 'BM skepticism';
    } else if (discourseType === 'concern') {
      category = INTENT_CATEGORIES.EMERGENCY;
      confidence = 0.7;
      reason = 'BM concern signal';
    }
    // Long messages with multiple sentences → likely deep
    else if (wordCount > 30) {
      category = INTENT_CATEGORIES.TASK_PLANNING;
      confidence = 0.7;
      reason = 'long complex message';
    } else if (questionCount >= 3) {
      category = INTENT_CATEGORIES.TASK_PLANNING;
      confidence = 0.75;
      reason = 'multiple questions';
    }
    // Default: conversation
    else {
      category = INTENT_CATEGORIES.CONVERSATION;
      confidence = 0.6;
      reason = 'casual conversation';
    }
  }

  // ── Step 4: Mood detection ────────────────────────────────────────────
  const { mood, confidence: moodConfidence } = detectMood(lower);

  // ── Step 5: Urgency detection ─────────────────────────────────────────
  const { isUrgent, confidence: urgencyConfidence } = detectUrgency(lower);

  // ── Step 6: Language detection ────────────────────────────────────────
  const { language } = detectLanguage(text);

  // ── Step 7: Determine tier ────────────────────────────────────────────
  const fastCategories = [INTENT_CATEGORIES.GREETING, INTENT_CATEGORIES.FEEDBACK];
  const deepCategories = [
    INTENT_CATEGORIES.TASK_REMINDER, INTENT_CATEGORIES.TASK_EVENT,
    INTENT_CATEGORIES.TASK_NOTE, INTENT_CATEGORIES.TASK_SEARCH,
    INTENT_CATEGORIES.TASK_PLANNING, INTENT_CATEGORIES.TASK_GOAL,
    INTENT_CATEGORIES.TASK_PROJECT, INTENT_CATEGORIES.TASK_MEMORY,
  ];

  let tier;
  if (fastCategories.includes(category)) {
    tier = 'fast';
  } else if (deepCategories.includes(category)) {
    tier = 'deep';
  } else if (isUrgent && urgencyConfidence > 0.7) {
    tier = 'deep';
    reason += ' (urgent)';
    category = INTENT_CATEGORIES.EMERGENCY;
  } else {
    tier = 'medium';
  }

  // ── Fast-tier override: simple time/date queries and bot identity ─────
  if (tier === 'medium' && category === INTENT_CATEGORIES.QUESTION_FACT) {
    if (reason === 'time/date query' || reason === 'bot identity question') {
      tier = 'fast';
    }
  }

  // ── Step 8: Context-aware escalation ──────────────────────────────────
  let needsEscalation = false;
  let escalationReason = '';

  if (context.workingMemory && context.workingMemory.currentGoal) {
    const wm = context.workingMemory;
    const goalWords = [wm.currentGoal, wm.currentProblem]
      .filter(Boolean)
      .flatMap(s => s.toLowerCase().split(/\s+/));
    const overlap = goalWords.filter(w => lower.includes(w)).length;

    if (overlap >= 2 && tier === 'medium') {
      needsEscalation = true;
      escalationReason = 'mid-task continuation (goal: ' + wm.currentGoal.slice(0, 50) + ')';
    }
  }

  // Check continuation signals
  if (context.recentMessages && context.recentMessages.length > 0) {
    const lastMsg = (context.recentMessages[context.recentMessages.length - 1] || '').toLowerCase();
    const isContinuation = CONTINUATION_SIGNALS.some(s => new RegExp('\\b' + s + '\\b', 'i').test(lower));
    if (isContinuation && tier !== 'deep') {
      needsEscalation = true;
      escalationReason = 'continuation signal after previous message';
    }
  }

  // ── Step 9: Sub-category refinement (Enhanced BM v2) ──────────────────
  let subCategory = '';

  // ── BM Temporal detection (Item #4) - boost time-sensitive sub-intents
  const { hasTemporal, types: temporalTypes } = detectTemporal(lower);

  // ── BM Affirmation/Negation detection (Item #11)
  const { type: affirmationType, confidence: affirmationConf } = detectAffirmation(lower);

  if (category === INTENT_CATEGORIES.TASK_REMINDER) {
    if (/\b(cancel|batalkan|padam|delete|buang|remove|batal|stop|berhenti|tak\s*jadi|tak\s*nak|tak\s*mahu)\b/i.test(lower)) subCategory = 'cancel';
    else if (/\b(edit|ubah|tukar|update|kemaskini|tukar\s*(tarikh|masa|waktu|info))\b/i.test(lower)) subCategory = 'update';
    else if (/\b(list|senarai|show|tunjuk|apa\s*ada|tengok\s*reminder|tengok\s*peringatan|senarai\s*reminder)\b/i.test(lower)) subCategory = 'list';
    else if (hasTemporal) subCategory = 'create_timed';
    else subCategory = 'create';
  }

  if (category === INTENT_CATEGORIES.TASK_EVENT) {
    if (/\b(cancel|batalkan|padam|delete|buang|remove|batal|stop)\b/i.test(lower)) subCategory = 'cancel';
    else if (/\b(edit|ubah|tukar|update|kemaskini|reschedule|jadual\s*semula)\b/i.test(lower)) subCategory = 'update';
    else if (/\b(list|senarai|show|tunjuk|jadual\s*(saya|aku|kami)|event\s*list|kalendar\s*(saya|aku))\b/i.test(lower)) subCategory = 'list';
    else if (/\b(lusa|tulat|minggu\s*depan|bulan\s*depan|esok|besok)\b/i.test(lower)) subCategory = 'create_future';
    else subCategory = 'create';
  }

  if (category === INTENT_CATEGORIES.TASK_NOTE) {
    if (/\b(list|senarai|show|tunjuk|baca|read|notes?\s*(saya|aku)|nota\s*(saya|aku))\b/i.test(lower)) subCategory = 'list';
    else if (/\b(delete|padam|buang|remove|buang\s*nota)\b/i.test(lower)) subCategory = 'delete';
    else subCategory = 'create';
  }

  if (category === INTENT_CATEGORIES.TASK_SEARCH) {
    if (/\b(berita|news|terkini|update|semasa|viral|trending|hot|hangat)\b/i.test(lower)) subCategory = 'news';
    else if (/\b(harga|price|kos|cost|mahal|murah|berapa\s*(harga|ringgit|rm))\b/i.test(lower)) subCategory = 'price';
    else if (/\b(tutorial|belajar|cara\s*nak|how\s*to|guide|panduan|steps?|langkah)\b/i.test(lower)) subCategory = 'tutorial';
    else if (/\b(cari\s*pasal|nak\s*tahu\s*pasal|cerita\s*pasal|info\s*pasal|fakta\s*pasal)\b/i.test(lower)) subCategory = 'info';
    else if (/\b(cari\s*(dalam|kat|dekat)|search\s*(dalam|kat|dekat))\b/i.test(lower)) subCategory = 'local';
    else subCategory = 'general';
  }

  // BM-specific sub-intents (Item #5)
  if (category === INTENT_CATEGORIES.CONVERSATION) {
    if (/\b(sejujurnya|aku\s*nak\s*mengaku|rasa\s*bersalah|confession|mengaku\s*je)\b/i.test(lower)) subCategory = 'confession';
    else if (/\b(bengangnya|menyampah\s*betul|geramnya|sakit\s*hati\s*dengan|komplen|mengadu|nak\s*mengadu|luah\s*perasaan)\b/i.test(lower)) subCategory = 'complaint';
    else if (/\b(cadangkan|apa\s*patut\s*buat|bagi\s*idea|idea\s*sikit|brainstorm|nak\s*pendapat|minta\s*pendapat)\b/i.test(lower)) subCategory = 'suggestion_request';
    else if (/\b(agak\s*agak|ramalkan|predict|apa\s*jadi\s*kalau|kalau\s*aku)\b/i.test(lower)) subCategory = 'prediction';
    else if (/\b(mana\s*lagi\s*bagus|pilih\s*yang\s*mana|nak\s*pilih|comparekan|bandingkan|antara.*dengan)\b/i.test(lower)) subCategory = 'comparison';
  }

  // ── BM-specific enrichments ─────────────────────────────────────────
  const formality = detectFormality(text);
  const affirmation = detectAffirmation(text);
  const temporal = detectTemporal(text);
  const discourse = detectDiscourseMarker(text);

  return {
    tier,
    category,
    subCategory,
    confidence,
    mood,
    moodConfidence,
    isUrgent,
    urgencyConfidence,
    language,
    reason,
    needsEscalation,
    escalationReason,
    // BM-specific metadata
    formality,
    affirmation,
    temporal,
    discourse,
  };
}

// ── Quick intent detection (backward compatible) ───────────────────────────
function detectIntent(text) {
  const result = detectIntentAdvanced(text);
  let provider = 'mimo';
  if (result.tier === 'deep') provider = 'deepseek';
  return {
    tier: result.tier,
    provider,
    reason: result.reason,
    category: result.category,
    confidence: result.confidence,
  };
}

module.exports = {
  detectIntent,
  detectIntentAdvanced,
  detectMood,
  detectUrgency,
  detectLanguage,
  detectFormality,
  detectAffirmation,
  detectDiscourseMarker,
  detectTemporal,
  detectBMCommands,
  INTENT_CATEGORIES,
};
