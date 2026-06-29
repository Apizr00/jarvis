// src/memory/domains.js
// ── Structured Memory Domains (Fasa 3) ─────────────────────────────────────
// Organizes memories into domain-specific categories for better context retrieval.
// Each domain has its own weight, schema, and relationship rules.
//
// Domains:
//   personal    — Identity, preferences, life events
//   work        — Job, projects, skills, colleagues
//   health      — Diet, exercise, sleep, medical
//   learning    — Studies, courses, books, skills
//   social      — Friends, family, relationships, events
//   finance     — Budget, investments, expenses, goals
//   schedule    — Routines, habits, time patterns
//   goals       — Long-term aspirations, milestones

const db = require('../db');

// ── Domain Definitions ──────────────────────────────────────────────────────

const DOMAINS = {
  personal: {
    name: 'Personal',
    icon: '👤',
    weight: 1.0,
    description: 'Identity, preferences, life events, personal details',
    keyPatterns: [
      /^(name|nama|full_name|nickname|nama_panggilan)/,
      /^(location|lokasi|address|alamat|live|tinggal|duduk)/,
      /^(birthday|birth_date|tarikh_lahir|age|umur)/,
      /^(language|bahasa|speak|cakap)/,
      /^(religion|agama|belief)/,
      /^(personality|personaliti|introvert|extrovert)/,
      /^(prefer|suka|like|favorite|kegemaran|hobby|hobi)/,
      /^(mood|feeling|rasa|emotional)/,
      /^(dream|cita_cita|aspiration)/,
    ],
  },
  work: {
    name: 'Work',
    icon: '💼',
    weight: 0.9,
    description: 'Job, projects, skills, colleagues, career',
    keyPatterns: [
      /^(job|pekerjaan|kerja|occupation|profession)/,
      /^(office|pejabat|workplace|tempat_kerja)/,
      /^(colleague|kolega|boss|team|pasukan)/,
      /^(skill|kemahiran|expertise)/,
      /^(project|projek|task|tugasan)/,
      /^(meeting|mesyuarat|deadline)/,
      /^(salary|gaji|income|pendapatan)/,
      /^(promotion|kenaikan_pangkat|career|kerjaya)/,
      /^(client|klien|customer|pelanggan)/,
      /^(freelance|side_hustle|business|perniagaan)/,
    ],
  },
  health: {
    name: 'Health',
    icon: '💪',
    weight: 0.85,
    description: 'Diet, exercise, sleep, medical, wellness',
    keyPatterns: [
      /^(diet|makanan|food|pemakanan|vegetarian|vegan)/,
      /^(exercise|senaman|workout|gym|fitness)/,
      /^(sleep|tidur|rest|rehat)/,
      /^(allergy|alergi|medical|perubatan|doctor|doktor)/,
      /^(weight|berat|height|tinggi|bmi)/,
      /^(water|air|hydration|hidrasi)/,
      /^(supplement|vitamin|ubat|medicine)/,
      /^(mental_health|kesihatan_mental|stress|tekanan)/,
      /^(smoke|rokok|alcohol|alkohol|habit|tabiat)/,
    ],
  },
  learning: {
    name: 'Learning',
    icon: '📚',
    weight: 0.8,
    description: 'Studies, courses, books, skills, education',
    keyPatterns: [
      /^(study|belajar|course|kursus|class|kelas)/,
      /^(book|buku|reading|bacaan|author|penulis)/,
      /^(learn|pelajari|skill|kemahiran)/,
      /^(university|universiti|college|kolej|school|sekolah)/,
      /^(exam|peperiksaan|test|ujian|grade|gred)/,
      /^(certificate|sijil|degree|ijazah|diploma)/,
      /^(topic|topik|subject|subjek|field|bidang)/,
      /^(research|kajian|thesis|tesis)/,
      /^(tutorial|guide|panduan)/,
    ],
  },
  social: {
    name: 'Social',
    icon: '👥',
    weight: 0.75,
    description: 'Friends, family, relationships, social events',
    keyPatterns: [
      /^(friend|kawan|best_friend|kawan_baik)/,
      /^(wife|isteri|husband|suami|partner|pasangan)/,
      /^(mother|ibu|emak|father|ayah|bapa|parent|ibubapa)/,
      /^(child|anak|son|daughter|baby)/,
      /^(sibling|adik_beradik|brother|sister)/,
      /^(relative|saudara|cousin|sepupu)/,
      /^(relationship|perhubungan|dating|couple)/,
      /^(social_event|majlis|party|gathering|kenduri)/,
      /^(community|komuniti|group|kumpulan)/,
    ],
  },
  finance: {
    name: 'Finance',
    icon: '💰',
    weight: 0.7,
    description: 'Budget, investments, expenses, financial goals',
    keyPatterns: [
      /^(budget|bajet|spending|perbelanjaan)/,
      /^(save|simpan|saving|tabung)/,
      /^(invest|labur|investment|pelaburan)/,
      /^(stock|saham|crypto|bitcoin|forex)/,
      /^(debt|hutang|loan|pinjaman)/,
      /^(bill|bil|payment|bayaran|subscription)/,
      /^(income|pendapatan|salary|gaji)/,
      /^(insurance|insurans|takaful)/,
      /^(tax|cukai|financial_goal|matlamat_kewangan)/,
    ],
  },
  schedule: {
    name: 'Schedule',
    icon: '📅',
    weight: 0.9,
    description: 'Routines, habits, time patterns, daily schedules',
    keyPatterns: [
      /^(routine|rutin|daily|harian|weekly|mingguan)/,
      /^(schedule|jadual|calendar|kalendar)/,
      /^(wake|bangun|morning|pagi|evening|petang|night|malam)/,
      /^(commute|ulang_alik|drive|memandu)/,
      /^(lunch|makan_tengahari|dinner|makan_malam|breakfast|sarapan)/,
      /^(weekend|hujung_minggu|saturday|sabtu|sunday|ahad)/,
      /^(time|masa|pukul|jam|hour)/,
      /^(habit|tabiat|always|selalu|usually|biasa)/,
    ],
  },
  goals: {
    name: 'Goals',
    icon: '🎯',
    weight: 0.85,
    description: 'Long-term goals, milestones, aspirations, targets',
    keyPatterns: [
      /^(goal|matlamat|target|sasaran|objective|objektif)/,
      /^(milestone|pencapaian|achievement)/,
      /^(resolution|azam|tekad|new_year)/,
      /^(dream|cita_cita|aspiration|ambition)/,
      /^(plan_(\d+)_year|rancangan_(\d+)_tahun)/,
      /^(bucket_list|wishlist|wish_list)/,
      /^(vision|visi|mission|misi)/,
      /^(legacy|warisan|impact|kesan)/,
    ],
  },
};

// ── Domain Classification ───────────────────────────────────────────────────

/**
 * Classify a fact key into its domain.
 * @param {string} key - fact key (e.g., "work_schedule", "diet_preference")
 * @returns {{domain: string, confidence: number}}
 */
function classifyFactDomain(key) {
  const lower = key.toLowerCase();
  const segments = lower.split(/[_\s-]+/); // split snake_case keys

  // Collect all matches with their segment positions
  const matches = [];

  for (const [domainName, domain] of Object.entries(DOMAINS)) {
    for (const pattern of domain.keyPatterns) {
      const source = pattern.source.replace(/^\^/, '').replace(/^\(|\)$/g, '');
      const alternatives = source.split('|');

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        for (const alt of alternatives) {
          if (seg === alt || (seg.startsWith(alt) && alt.length >= seg.length * 0.5)) {
            matches.push({
              domain: domainName,
              weight: domain.weight,
              segmentIndex: i,
              isExact: seg === alt,
            });
            break; // one match per pattern per segment
          }
        }
      }
    }
  }

  if (matches.length === 0) {
    return { domain: 'personal', confidence: 0.5 };
  }

  // Sort: prefer exact match on earlier segment, then by weight
  matches.sort((a, b) => {
    // Early segment beats later segment (first segment is the domain prefix)
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
    // Exact match beats partial
    if (a.isExact !== b.isExact) return a.isExact ? -1 : 1;
    // Higher weight beats lower
    return b.weight - a.weight;
  });

  return { domain: matches[0].domain, confidence: matches[0].weight };
}

// ── Domain-Aware Context Building ───────────────────────────────────────────

/**
 * Build domain-organized context for LLM prompt.
 * Groups facts by their domains for better comprehension.
 * 
 * @param {string} userId
 * @param {Array<{key:string, value:string, confidence?:number}>} facts
 * @returns {string} formatted domain context block
 */
function buildDomainContext(facts) {
  if (!facts || facts.length === 0) return '';

  // Group facts by domain
  const grouped = {};
  for (const fact of facts) {
    const { domain } = classifyFactDomain(fact.key);
    if (!grouped[domain]) grouped[domain] = [];
    grouped[domain].push(fact);
  }

  // Build formatted output
  const blocks = [];
  for (const [domainName, domainFacts] of Object.entries(grouped)) {
    const domain = DOMAINS[domainName];
    if (!domain || domainFacts.length === 0) continue;

    const header = domain.icon + ' ' + domain.name.toUpperCase();
    const lines = domainFacts.map(f => '  • ' + f.key + ': ' + f.value);
    blocks.push(header + '\n' + lines.join('\n'));
  }

  return blocks.length > 0
    ? 'MEMORY DOMAINS ─────────────────────\n' + blocks.join('\n\n')
    : '';
}

/**
 * Get all domains with their current fact counts for a user.
 * Useful for understanding which areas have the most data.
 * 
 * @param {string} userId 
 * @returns {Promise<Array<{domain:string, name:string, icon:string, count:number}>>}
 */
async function getDomainStats(userId) {
  const allFacts = await db.getAllFacts(userId);

  const stats = {};
  for (const domainName of Object.keys(DOMAINS)) {
    stats[domainName] = { domain: domainName, ...DOMAINS[domainName], count: 0 };
  }

  for (const fact of allFacts) {
    const { domain } = classifyFactDomain(fact.key);
    if (stats[domain]) stats[domain].count++;
  }

  return Object.values(stats).sort((a, b) => b.count - a.count);
}

/**
 * Get the most relevant domain for a user message.
 * Used to prioritize which domain's facts to include.
 * 
 * @param {string} userMessage
 * @returns {{domain: string, confidence: number}}
 */
function detectActiveDomain(userMessage) {
  const lower = userMessage.toLowerCase();

  // Order matters: health before work (since "workout" contains "work")
  // Use word boundary matching for more accurate detection
  const domainKeywords = {
    health: ['exercise', 'senaman', 'gym', 'workout', 'diet', 'sleep', 'tidur', 'doctor', 'doktor', 'run', 'lari', 'jogging', 'yoga', 'weight', 'berat', 'healthy', 'sihat', 'fitness'],
    learning: ['study', 'belajar', 'course', 'kursus', 'learn', 'book', 'buku', 'read', 'baca', 'exam', 'class', 'kelas', 'tutorial', 'skill', 'kemahiran'],
    work: ['kerja', 'office', 'pejabat', 'meeting', 'mesyuarat', 'colleague', 'boss', 'project', 'projek', 'task', 'tugasan', 'client', 'klien', 'deadline', 'code', 'coding'],
    social: ['friend', 'kawan', 'family', 'keluarga', 'wife', 'isteri', 'husband', 'suami', 'party', 'meet', 'jumpa', 'hangout'],
    finance: ['money', 'duit', 'ringgit', 'rm ', 'bank', 'saving', 'simpan', 'invest', 'labur', 'saham', 'stock', 'budget', 'bajet', 'bill', 'bil ', 'bayar'],
    schedule: ['routine', 'rutin', 'schedule', 'jadual', 'pukul', 'jam', 'minggu', 'hari', 'week', 'day', 'calendar', 'kalendar'],
    goals: ['goal', 'matlamat', 'target', 'sasaran', 'achieve', 'capai', 'resolution', 'azam', 'dream', 'cita_cita'],
  };

  let bestDomain = 'personal';
  let bestScore = 0;

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }

  return { domain: bestDomain, confidence: Math.min(bestScore / 3, 1.0) };
}

// ── Domain Relationship Rules ───────────────────────────────────────────────

/**
 * Define cross-domain relationships.
 * E.g., "work" affects "schedule", "finance" affects "goals".
 */
const CROSS_DOMAIN_RULES = [
  { from: 'work', to: 'schedule', relation: 'influences', weight: 0.8 },
  { from: 'work', to: 'finance', relation: 'funds', weight: 0.7 },
  { from: 'work', to: 'goals', relation: 'advances', weight: 0.6 },
  { from: 'health', to: 'work', relation: 'enables', weight: 0.7 },
  { from: 'health', to: 'schedule', relation: 'shapes', weight: 0.8 },
  { from: 'learning', to: 'work', relation: 'improves', weight: 0.8 },
  { from: 'learning', to: 'goals', relation: 'advances', weight: 0.7 },
  { from: 'finance', to: 'goals', relation: 'enables', weight: 0.7 },
  { from: 'social', to: 'schedule', relation: 'fills', weight: 0.9 },
  { from: 'schedule', to: 'health', relation: 'structures', weight: 0.8 },
  { from: 'goals', to: 'work', relation: 'directs', weight: 0.7 },
  { from: 'goals', to: 'learning', relation: 'motivates', weight: 0.6 },
];

/**
 * Get related domains for contextual recommendations.
 * @param {string} domain
 * @returns {Array<{domain: string, relation: string, weight: number}>}
 */
function getRelatedDomains(domain) {
  return CROSS_DOMAIN_RULES
    .filter(r => r.from === domain)
    .map(r => ({ domain: r.to, relation: r.relation, weight: r.weight }));
}

module.exports = {
  DOMAINS,
  classifyFactDomain,
  buildDomainContext,
  getDomainStats,
  detectActiveDomain,
  getRelatedDomains,
};
