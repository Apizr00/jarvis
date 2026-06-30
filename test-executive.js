// test-executive.js
// Quick smoke test for the Executive Layer (Fasa 1).
// Run: node test-executive.js
// No LLM API needed — tests decision logic, working memory, world model.
require('dotenv').config();

const executive = require('./src/executive');
const wm = executive.workingMemory;

let passed = 0;
let failed = 0;
function ok(label) { passed++; console.log('  ✅ ' + label); }
function fail(label, err) { failed++; console.log('  ❌ ' + label + ' — ' + (err?.message || err)); }
function assert(cond, label) { cond ? ok(label) : fail(label); }

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Executive Layer Smoke Test        ║');
  console.log('╚══════════════════════════════════════╝\n');

  // ── 1. Intent Detection ─────────────────────────────────────────────
  console.log('📋 1. Intent Detection');
  const intents = {
    'Hi': 'fast',
    'Pukul berapa sekarang?': 'fast',
    'Terima kasih!': 'fast',
    'Macam mana nak guna React?': 'medium',
    'Cerita pasal diri kau': 'medium',
    'Remind me to call mum at 6pm': 'deep',
    'Saya nak beli kereta': 'deep',
    'Create a task for project X': 'deep',
    'Sambung projek Telegram bot': 'deep',
    'Cari berita terkini tentang AI': 'deep',
  };

  for (const [msg, expected] of Object.entries(intents)) {
    const d = await executive.decide('test', msg);
    assert(d.tier === expected,
      '"' + msg + '" → ' + d.tier.toUpperCase() + ' (expected ' + expected.toUpperCase() + ')');
  }

  // ── 2. Working Memory ───────────────────────────────────────────────
  console.log('\n📋 2. Working Memory');
  const wmUser = 'wm_test_user';
  wm.reset(wmUser);

  // Empty state
  assert(!wm.isActive(wmUser), 'Empty working memory is NOT active');

  // Update with goal/problem
  wm.update(wmUser, { currentGoal: 'Build AI Assistant', currentProblem: 'Memory too slow' });
  assert(wm.isActive(wmUser), 'Working memory IS active after setting goal');

  // Add solutions and steps
  wm.update(wmUser, { addSolution: 'Hybrid RAG', addNextStep: 'Implement embedding' });
  wm.update(wmUser, { rejectSolution: 'Store everything' });

  const formatted = wm.formatForPrompt(wmUser);
  assert(formatted.includes('Build AI Assistant'), 'WM prompt contains goal');
  assert(formatted.includes('Hybrid RAG'), 'WM prompt contains solution');
  assert(formatted.includes('Implement embedding'), 'WM prompt contains next step');
  assert(!formatted.includes('Store everything'), 'WM prompt does NOT show rejected ideas');

  // Complete a step
  wm.update(wmUser, { completeNextStep: 'Implement embedding' });
  const afterComplete = wm.formatForPrompt(wmUser);
  assert(!afterComplete.includes('Implement embedding'), 'Completed step removed from WM');

  wm.reset(wmUser);
  ok('WM reset works');

  // ── 3. World Model ──────────────────────────────────────────────────
  console.log('\n📋 3. World Model');
  executive.updateWorldModel('test', {
    status: 'working',
    currentProject: 'Telegram Bot',
    budget: 'limited',
    interests: ['AI', 'Coding'],
  });

  const world = executive.formatWorldModelForPrompt('test');
  assert(world.includes('Working') || world.includes('working'), 'World model contains status');
  assert(world.includes('Telegram Bot'), 'World model contains project');
  assert(world.includes('AI'), 'World model contains interests');

  ok('World model updates correctly');

  // ── 4. Decision Needs Assessment ────────────────────────────────────
  console.log('\n📋 4. Needs Assessment');

  // Fast tier: nothing needed
  const fastD = await executive.decide('test', 'Hi');
  assert(fastD.needs.memory === false, 'Fast: no memory needed');
  assert(fastD.needs.tools === false, 'Fast: no tools needed');
  assert(fastD.needs.planning === false, 'Fast: no planning needed');

  // Deep tier: everything needed
  const deepD = await executive.decide('test', 'Remind me to call mum at 6pm');
  assert(deepD.needs.memory === true, 'Deep: memory needed');
  assert(deepD.needs.tools === true, 'Deep: tools needed');
  assert(deepD.needs.planning === true, 'Deep: planning needed');
  assert(deepD.needs.workingMemory === true, 'Deep: working memory needed');

  // Deep mid-task continuation (message must overlap with working memory goal)
  wm.update('test', { currentGoal: 'Build Telegram Bot', currentProblem: 'Memory retrieval' });
  const midTask = await executive.decide('test', 'How should I build the Telegram bot database layer?');
  assert(midTask.tier === 'deep', 'Mid-task continuation → escalated to DEEP (overlap: build+telegram+bot)');
  assert(midTask.workingMemoryActive === true, 'Working memory active during mid-task');

  wm.reset('test');

  // ── 5. Post-Processing Decisions ────────────────────────────────────
  console.log('\n📋 5. Post-Processing');

  const fastPost = executive.decidePostProcessing({ tier: 'fast', needs: {} }, { type: 'message', content: 'Hi' });
  assert(fastPost.extractFacts === false, 'Fast: no fact extraction');
  assert(fastPost.extractPeople === false, 'Fast: no people extraction');
  assert(fastPost.trackPatterns === true, 'Fast: still track patterns');

  const medPost = executive.decidePostProcessing({ tier: 'medium', needs: {} }, { type: 'message', content: 'x' });
  assert(medPost.extractFacts === true, 'Medium: fact extraction');
  assert(medPost.extractPeople === true, 'Medium: people extraction');

  const deepPost = executive.decidePostProcessing({ tier: 'deep', needs: {} }, { type: 'tool', name: 'create_reminder' });
  assert(deepPost.extractFacts === true, 'Deep: fact extraction');
  assert(deepPost.extractPeople === true, 'Deep: people extraction');
  assert(deepPost.updateWorkingMemory === true, 'Deep: update working memory');

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
  if (failed === 0) {
    console.log('🎉 Executive Layer is working correctly!\n');
  } else {
    console.log('⚠️  Some tests failed. Check the output above.\n');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
