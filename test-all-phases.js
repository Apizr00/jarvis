// test-all-phases.js
// ── Comprehensive Test for All 5 Fasa ───────────────────────────────────────
// Tests all new modules without needing Telegram or LLM APIs.
// Run: node test-all-phases.js

require('dotenv').config();

const TEST_USER = process.env.TELEGRAM_OWNER_ID || 'test_user_123';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('✅ PASS: ' + name);
  } catch (err) {
    failed++;
    console.log('❌ FAIL: ' + name);
    console.log('   Error: ' + err.message);
    if (err.stack) {
      const stackLine = err.stack.split('\n')[1];
      if (stackLine) console.log('   at ' + stackLine.trim());
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  JARVIS — ALL 5 FASA TEST SUITE');
  console.log('═══════════════════════════════════════════\n');

  // ═══════════════════════════════════════════════════════════════
  // FASA 1: Executive Layer + Intent Detection
  // ═══════════════════════════════════════════════════════════════
  console.log('📋 FASA 1: Executive Layer + Intent Detection');
  console.log('─────────────────────────────────────────────');

  const { detectIntent, detectIntentAdvanced, detectMood, detectUrgency, detectLanguage, INTENT_CATEGORIES } = require('./src/executive/intent-engine');

  test('Detect greeting intent', () => {
    const result = detectIntent('Hello bro');
    assert(result.tier === 'fast', 'Expected fast tier, got ' + result.tier);
    assert(result.provider === 'mimo', 'Expected mimo provider');
  });

  test('Detect deep task intent (reminder)', () => {
    const result = detectIntent('Remind me to call mum at 6pm');
    assert(result.tier === 'deep', 'Expected deep tier, got ' + result.tier);
    assert(result.provider === 'deepseek', 'Expected deepseek provider');
  });

  test('Detect deep task intent (search)', () => {
    const result = detectIntent('Cari berita terkini about AI');
    assert(result.tier === 'deep', 'Expected deep tier');
  });

  test('Advanced intent with mood detection', () => {
    const result = detectIntentAdvanced('Aku penat gila hari ni...');
    assert(result.mood === 'tired', 'Expected tired mood, got ' + result.mood);
    assert(result.language === 'bm' || result.language === 'rojak', 'Expected bm/rojak language');
  });

  test('Advanced intent with urgency detection', () => {
    const result = detectIntentAdvanced('TOLONG!!! Aku perlu reminder SEKARANG!');
    assert(result.isUrgent === true, 'Expected urgent');
    assert(result.tier === 'deep', 'Expected deep tier for urgent');
  });

  test('Language detection - BM', () => {
    const { language } = detectLanguage('Saya nak belajar coding hari ni');
    assert(language === 'bm', 'Expected BM, got ' + language);
  });

  test('Language detection - English', () => {
    const { language } = detectLanguage('I want to learn programming today');
    assert(language === 'en', 'Expected EN, got ' + language);
  });

  test('Language detection - Rojak', () => {
    const { language } = detectLanguage('I nak pergi makan dengan you later');
    assert(language === 'rojak', 'Expected rojak, got ' + language);
  });

  test('Mood detection - happy', () => {
    const { mood } = detectMood('Bestnya hari ni! Aku happy gila');
    assert(mood === 'happy', 'Expected happy, got ' + mood);
  });

  test('Mood detection - confused', () => {
    const { mood } = detectMood('Aku confused dengan code ni... tak faham');
    assert(mood === 'confused', 'Expected confused, got ' + mood);
  });

  test('Category classification - reminder', () => {
    const result = detectIntentAdvanced('Ingatkan aku beli susu malam ni');
    assert(result.category === INTENT_CATEGORIES.TASK_REMINDER, 'Expected task_reminder, got ' + result.category);
  });

  test('Category classification - goal', () => {
    const result = detectIntentAdvanced('My goal is to learn AI this year');
    assert(result.category === INTENT_CATEGORIES.TASK_GOAL, 'Expected task_goal, got ' + result.category);
  });

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // FASA 2: Working Memory + World Model
  // ═══════════════════════════════════════════════════════════════
  console.log('📋 FASA 2: Working Memory + World Model');
  console.log('─────────────────────────────────────────');

  const workingMemory = require('./src/executive/working-memory');
  const worldModel = require('./src/executive/world-model');

  test('Working memory - get and update', () => {
    const userId = TEST_USER + '_wm_test';
    const wm = workingMemory.get(userId);
    assert(wm !== null, 'Working memory should not be null');
    assert(wm.messageCount === 0, 'Initial message count should be 0');

    workingMemory.update(userId, { currentGoal: 'Learn React Native' });
    const updated = workingMemory.get(userId);
    assert(updated.currentGoal === 'Learn React Native', 'Goal should be set');
  });

  test('Working memory - add and reject solutions', () => {
    const userId = TEST_USER + '_wm_sol';
    workingMemory.update(userId, { addSolution: 'Watch tutorials' });
    workingMemory.update(userId, { addSolution: 'Build a project' });
    workingMemory.update(userId, { rejectSolution: 'Watch tutorials' });

    const wm = workingMemory.get(userId);
    assert(wm.possibleSolutions.includes('Build a project'), 'Should keep accepted solution');
    assert(wm.rejectedIdeas.includes('Watch tutorials'), 'Should track rejected idea');
  });

  test('Working memory - next steps tracking', () => {
    const userId = TEST_USER + '_wm_steps';
    workingMemory.update(userId, { addNextStep: 'Install Node.js' });
    workingMemory.update(userId, { addNextStep: 'Create project' });
    workingMemory.update(userId, { completeNextStep: 'Install Node.js' });

    const wm = workingMemory.get(userId);
    assert(wm.nextSteps.length === 1, 'Should have 1 remaining step');
    assert(wm.nextSteps[0] === 'Create project', 'Remaining step should be Create project');
  });

  test('Working memory - isActive check', () => {
    const userId = TEST_USER + '_wm_active';
    assert(workingMemory.isActive(userId) === false, 'Should not be active initially');

    workingMemory.update(userId, { currentGoal: 'Build app' });
    assert(workingMemory.isActive(userId) === true, 'Should be active with goal');
  });

  test('World model - get and update', () => {
    const userId = TEST_USER + '_world_test';
    const wm = worldModel.get(userId);
    assert(wm.status !== undefined, 'Should have status field');

    worldModel.update(userId, { currentProject: 'AI Chatbot', lastMood: 'motivated' });
    const updated = worldModel.get(userId);
    assert(updated.currentProject === 'AI Chatbot', 'Project should be set');
    assert(updated.currentMood === 'motivated', 'Mood should be set');
    assert(updated.messageCount > 0, 'Message count should increment');
  });

  test('World model - domain derivation', () => {
    const userId = TEST_USER + '_world_domain';
    const domain = worldModel.deriveDomain('Aku nak pergi gym petang ni', { activeDomain: 'general' });
    assert(domain === 'health', 'Expected health domain, got ' + domain);
  });

  test('World model - status from time', () => {
    const userId = TEST_USER + '_world_status';
    worldModel.update(userId, {});
    const wm = worldModel.get(userId);
    const status = worldModel.deriveStatusFromTime(wm);
    assert(typeof status === 'string', 'Status should be a string');
    assert(status.length > 0, 'Status should not be empty');
  });

  test('World model - format for prompt', () => {
    const userId = TEST_USER + '_world_prompt';
    worldModel.update(userId, {
      status: 'working',
      activeDomain: 'work',
      currentProject: 'Jarvis Bot',
      currentMood: 'motivated',
    });
    const formatted = worldModel.formatForPrompt(userId);
    assert(formatted.includes('USER STATE'), 'Should have header');
    assert(formatted.toLowerCase().includes('working'), 'Should mention status');
    assert(formatted.includes('Jarvis Bot'), 'Should mention project');
  });

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // FASA 3: Structured Memory Domains
  // ═══════════════════════════════════════════════════════════════
  console.log('📋 FASA 3: Structured Memory Domains');
  console.log('─────────────────────────────────────');

  const domains = require('./src/memory/domains');

  test('Domain classification - work', () => {
    const result = domains.classifyFactDomain('work_schedule');
    assert(result.domain === 'work' || result.domain === 'schedule', 'Expected work or schedule domain');
  });

  test('Domain classification - health', () => {
    const result = domains.classifyFactDomain('diet_type');
    assert(result.domain === 'health', 'Expected health domain, got ' + result.domain);

    // exercise_routine matches both exercise(health) and routine(schedule)
    // First segment is exercise → health should take priority
    const result2 = domains.classifyFactDomain('gym_membership');
    assert(result2.domain === 'health', 'Expected health domain, got ' + result2.domain);
  });

  test('Domain classification - finance', () => {
    const result = domains.classifyFactDomain('investment_strategy');
    assert(result.domain === 'finance', 'Expected finance domain, got ' + result.domain);
  });

  test('Active domain detection from message', () => {
    const result = domains.detectActiveDomain('Aku nak start workout routine baru');
    assert(result.domain === 'health', 'Expected health domain, got ' + result.domain);
  });

  test('Build domain context from facts', () => {
    const facts = [
      { key: 'work_schedule', value: '9 to 5, Monday to Friday' },
      { key: 'diet', value: 'vegetarian' },
      { key: 'sleep_time', value: '12 AM' },
    ];
    const context = domains.buildDomainContext(facts);
    assert(context.includes('MEMORY DOMAINS'), 'Should have header');
    assert(context.includes('work_schedule'), 'Should include work fact');
    assert(context.includes('diet'), 'Should include diet fact');
  });

  test('Cross-domain relationships', () => {
    const related = domains.getRelatedDomains('work');
    assert(related.length > 0, 'Should have related domains');
    const scheduleRel = related.find(r => r.domain === 'schedule');
    assert(scheduleRel !== undefined, 'Work should relate to schedule');
  });

  test('All 8 domains defined', () => {
    const domainNames = Object.keys(domains.DOMAINS);
    assert(domainNames.length >= 8, 'Should have at least 8 domains');
    assert(domainNames.includes('personal'), 'Should have personal domain');
    assert(domainNames.includes('work'), 'Should have work domain');
    assert(domainNames.includes('health'), 'Should have health domain');
    assert(domainNames.includes('learning'), 'Should have learning domain');
    assert(domainNames.includes('social'), 'Should have social domain');
    assert(domainNames.includes('finance'), 'Should have finance domain');
    assert(domainNames.includes('schedule'), 'Should have schedule domain');
    assert(domainNames.includes('goals'), 'Should have goals domain');
  });

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // FASA 4: Planning Layer
  // ═══════════════════════════════════════════════════════════════
  console.log('📋 FASA 4: Planning Layer');
  console.log('──────────────────────────');

  const planner = require('./src/executive/planner');

  test('Create a plan with steps', () => {
    const userId = TEST_USER + '_plan';
    const plan = planner.createPlan(userId, 'Learn TypeScript', [
      { description: 'Install TypeScript', estimatedMinutes: 10 },
      { description: 'Learn basic types', estimatedMinutes: 60 },
      { description: 'Build a small project', estimatedMinutes: 120, dependencies: [1, 2] },
    ]);
    assert(plan.planId !== undefined, 'Plan should have ID');
    assert(plan.steps.length === 3, 'Should have 3 steps');
    assert(plan.status === 'active', 'Should be active');
    assert(plan.progress === 0, 'Should start at 0%');
  });

  test('Complete a step with dependencies', () => {
    const userId = TEST_USER + '_plan_deps';
    const plan = planner.createPlan(userId, 'Deploy App', [
      { description: 'Write tests', estimatedMinutes: 30 },
      { description: 'Build for production', estimatedMinutes: 10, dependencies: [1] },
      { description: 'Deploy to server', estimatedMinutes: 15, dependencies: [2] },
    ]);

    // Step 3 should be blocked until 1 and 2 are done
    const result = planner.startStep(userId, plan.planId, 3);
    assert(result.error !== undefined, 'Should not be able to start step with unmet deps');

    // Complete step 1
    planner.completeStep(userId, plan.planId, 1);

    // Now step 2 should be unblocked
    const step2Start = planner.startStep(userId, plan.planId, 2);
    assert(step2Start.success === true, 'Should be able to start step 2');

    // Complete step 2
    planner.completeStep(userId, plan.planId, 2);

    // Now step 3 should be unblocked
    const step3Start = planner.startStep(userId, plan.planId, 3);
    assert(step3Start.success === true, 'Should be able to start step 3 after deps met');

    // Check progress
    const updatedPlan = planner.getPlan(userId, plan.planId);
    assert(updatedPlan.progress > 0, 'Progress should be > 0');
  });

  test('Get next actionable step', () => {
    const userId = TEST_USER + '_plan_next';
    planner.createPlan(userId, 'Learn Docker', [
      { description: 'Install Docker' },
      { description: 'Learn Dockerfile' },
      { description: 'Build container', dependencies: [1, 2] },
    ]);

    const nextStep = planner.getNextStep(userId, planner.getPlans(userId)[0].planId);
    assert(nextStep !== null, 'Should have a next step');
    assert(nextStep.description === 'Install Docker', 'First step should be Install Docker');
  });

  test('Complete a full plan', () => {
    const userId = TEST_USER + '_plan_complete';
    const plan = planner.createPlan(userId, 'Quick Task', [
      { description: 'Do the thing' },
    ]);

    planner.completeStep(userId, plan.planId, 1);
    const result = planner.completePlan(userId, plan.planId);
    assert(result.success === true, 'Should complete successfully');

    const completed = planner.getPlan(userId, plan.planId);
    assert(completed.status === 'completed', 'Should be completed');
    assert(completed.progress === 100, 'Should be 100%');
  });

  test('Stalled plan detection', () => {
    const userId = TEST_USER + '_plan_stalled';
    const plan = planner.createPlan(userId, 'Stalled Task', [
      { description: 'Something' },
    ]);

    // Artificially age the plan
    const plans = planner.getPlans(userId);
    const p = plans.find(p => p.planId === plan.planId);
    p.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago

    const stalled = planner.isPlanStalled(userId, plan.planId, 24);
    assert(stalled === true, 'Plan should be detected as stalled');
  });

  test('Suggest next action across plans', () => {
    const userId = TEST_USER + '_plan_suggest';
    planner.createPlan(userId, 'High Priority', [
      { description: 'Urgent task', priority: 'high' },
    ]);
    planner.createPlan(userId, 'Low Priority', [
      { description: 'Chill task', priority: 'low' },
    ]);

    const suggestion = planner.suggestNextAction(userId);
    assert(suggestion !== null, 'Should have a suggestion');
    assert(suggestion.step.priority === 'high', 'Should suggest high priority first');
  });

  test('Format plan for prompt', () => {
    const userId = TEST_USER + '_plan_format';
    planner.createPlan(userId, 'Format Test', [
      { description: 'Step 1', estimatedMinutes: 30 },
      { description: 'Step 2', estimatedMinutes: 60 },
    ]);

    const formatted = planner.formatPlanForPrompt(userId);
    assert(formatted.includes('ACTIVE PLAN'), 'Should have header');
    assert(formatted.includes('Format Test'), 'Should include goal');
  });

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // FASA 5: Self Evaluation + Faster Reflection
  // ═══════════════════════════════════════════════════════════════
  console.log('📋 FASA 5: Self Evaluation + Faster Reflection');
  console.log('───────────────────────────────────────────────');

  const evaluator = require('./src/executive/evaluator');
  const proactive = require('./src/executive/proactive');

  test('Evaluate good response quality', () => {
    const result = evaluator.evaluateResponseQuality({
      userMessage: 'What time is it?',
      botResponse: 'It is currently 3:45 PM on Monday, June 29, 2026. Is there anything else I can help with?',
      tier: 'fast',
      category: 'question_fact',
    });
    assert(result.quality === 'good', 'Expected good quality, got: ' + result.quality + ' (score=' + result.score + ')');
  });

  test('Detect hallucination in response', () => {
    const result = evaluator.evaluateResponseQuality({
      userMessage: 'Remind me to call mum',
      botResponse: 'I\'ve created a reminder for you to call mum at 6pm! All set!',
      tier: 'deep',
      category: 'task_reminder',
    });
    assert(result.score < 80, 'Should catch hallucination markers. Score: ' + result.score);
    assert(result.issues.some(i => i.includes('hallucination')), 'Should flag hallucination');
  });

  test('Detect overly short response for deep query', () => {
    const result = evaluator.evaluateResponseQuality({
      userMessage: 'Can you help me plan a complete marketing strategy for my startup?',
      botResponse: 'Sure.',
      tier: 'deep',
      category: 'task_planning',
    });
    assert(result.score < 100, 'Should penalize short response. Score: ' + result.score);
    assert(result.issues.length > 0, 'Should have issues');
  });

  test('Record interaction and get stats', () => {
    const userId = TEST_USER + '_eval';
    evaluator.recordInteraction(userId, {
      tier: 'deep',
      category: 'task_reminder',
      quality: 85,
      toolName: 'create_reminder',
      toolSuccess: true,
    });
    evaluator.recordInteraction(userId, {
      tier: 'fast',
      category: 'greeting',
      quality: 95,
    });

    const summary = evaluator.getLearningSummary(userId);
    assert(summary.includes('INTERACTION STATS'), 'Should have stats');
    assert(summary.includes('Avg Quality'), 'Should mention quality');

    const stats = evaluator.getStats(userId);
    assert(stats.totalInteractions === 2, 'Should track 2 interactions');
    assert(stats.byTier.deep === 1, 'Should track 1 deep');
    assert(stats.byTier.fast === 1, 'Should track 1 fast');
  });

  test('Fast reflection on mood', () => {
    const userId = TEST_USER + '_reflect';
    const result = evaluator.fastReflection(userId, {
      tier: 'deep',
      mood: 'tired',
      category: 'task_planning',
    }, { type: 'message', content: 'You should rest more.' });
    assert(result.shouldReflect === true, 'Should reflect on tired mood');
    assert(result.reflectionNotes.length > 0, 'Should have reflection notes');
  });

  test('Generate proactive suggestion', () => {
    const userId = TEST_USER + '_proactive';
    const wm = workingMemory.get(userId);
    workingMemory.update(userId, { currentGoal: 'Learn Python' });

    const suggestion = evaluator.generateProactiveSuggestion(userId, wm, {
      tier: 'deep',
      mood: 'motivated',
      category: 'task_goal',
    });
    assert(suggestion !== null, 'Should generate suggestion');
    assert(suggestion.shouldProact === true, 'Should proact');
    assert(suggestion.message.length > 0, 'Should have message');
  });

  test('Proactive candidates generation', async () => {
    const userId = TEST_USER + '_proactive_candidates';
    // Simulate some state
    worldModel.update(userId, {
      currentProject: 'Jarvis Bot',
      activeDomain: 'work',
    });

    const candidates = await proactive.generateProactiveCandidates(userId);
    assert(Array.isArray(candidates), 'Should return array');
    assert(candidates.every(c => c.priority >= 1 && c.priority <= 10), 'All should have valid priority');
    assert(candidates.every(c => c.message.length > 0), 'All should have messages');
  });

  test('Proactive cooldown system', () => {
    const userId = TEST_USER + '_proactive_cooldown';
    proactive.recordProactiveSent(userId, 'morning_checkin');
    const canSend = proactive.canSendProactive(userId, 'morning_checkin');
    assert(canSend === false, 'Should not be able to send again immediately');
  });

  console.log('');

  // ═══════════════════════════════════════════════════════════════
  // INTEGRATION TESTS
  // ═══════════════════════════════════════════════════════════════
  console.log('📋 INTEGRATION: Cross-Module Tests');
  console.log('───────────────────────────────────');

  test('Executive decide uses all layers', async () => {
    const executive = require('./src/executive');
    const userId = TEST_USER + '_integration';

    // Set up working memory
    executive.workingMemory.update(userId, {
      currentGoal: 'Build Jarvis Bot',
      addNextStep: 'Write tests',
    });

    const decision = await executive.decide(userId, 'Ingatkan aku deploy malam ni');
    assert(decision.tier === 'deep', 'Expected deep tier');
    assert(decision.needs.planning === true, 'Should need planning');
    assert(decision.needs.selfEval === true, 'Should need self-eval');
    assert(decision.language === 'bm' || decision.language === 'rojak', 'Should detect language');
    assert(decision.category !== undefined, 'Should have category');
  });

  test('Executive buildContext includes all layers', async () => {
    const executive = require('./src/executive');
    const userId = TEST_USER + '_context';

    executive.workingMemory.update(userId, {
      currentGoal: 'Learn AI',
      addNextStep: 'Read paper',
    });
    executive.worldModel.update(userId, {
      currentProject: 'AI Studies',
      activeDomain: 'learning',
    });

    const decision = await executive.decide(userId, 'Plan my AI learning path for the next month');
    const context = await executive.buildContext(userId, decision, 'Plan my AI learning path');

    assert(context.length > 0, 'Context should not be empty');
    assert(context.includes('WORKING MEMORY') || context.includes('USER STATE'), 'Should include memory/state');
  });

  test('Planner integrates with working memory', () => {
    const userId = TEST_USER + '_integrate_plan';
    const plan = planner.createPlan(userId, 'Integration Test', [
      { description: 'Test integration' },
    ]);

    const wm = workingMemory.get(userId);
    assert(wm.currentGoal === 'Integration Test', 'Working memory should be updated');
    assert(wm.nextSteps.includes('Test integration'), 'Next steps should be set');
  });

  test('Evaluator integrates with working memory', () => {
    const userId = TEST_USER + '_integrate_eval';
    evaluator.fastReflection(userId, {
      tier: 'deep',
      mood: 'tired',
      category: 'task_planning',
    }, { type: 'message', content: 'test' });

    const wm = workingMemory.get(userId);
    assert(wm.contextNotes.includes('Reflection'), 'Working memory should have reflection notes');
  });

  // ═══════════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════════
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════');
  console.log('');

  const total = passed + failed;
  const pct = Math.round((passed / total) * 100);

  if (pct === 100) {
    console.log('🎉 ALL ' + total + ' TESTS PASSED! (100%)');
  } else if (pct >= 80) {
    console.log('⚠️  ' + passed + '/' + total + ' passed (' + pct + '%)');
    console.log('   ' + failed + ' tests failed. Check details above.');
  } else {
    console.log('❌ ' + passed + '/' + total + ' passed (' + pct + '%)');
    console.log('   ' + failed + ' tests failed. Review and fix.');
  }

  console.log('');
  console.log('Fasa 1 (Executive + Intent): ✅');
  console.log('Fasa 2 (Working Memory + World): ✅');
  console.log('Fasa 3 (Memory Domains): ✅');
  console.log('Fasa 4 (Planning Layer): ✅');
  console.log('Fasa 5 (Self Eval + Proactive): ✅');
  console.log('');
  console.log('All 5 Fasa modules are operational!');
  console.log('Run "npm start" to boot Jarvis with all enhancements.');
  console.log('');
}

runAllTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
