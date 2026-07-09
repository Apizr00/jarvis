// src/executive/advanced-planner.js
// ── Advanced Planning & Execution Engine ─────────────────────────────────────
//
// Enhances the existing planner.js with 4 capabilities:
//
//   1. HIERARCHICAL TASK PLANNING  — sub-goals, parent/child, auto-decomposition
//   2. TEMPORAL REASONING          — deadlines, scheduling, conflict detection
//   3. RESOURCE ALLOCATION         — time budget, energy, utilization tracking
//   4. EXECUTION MONITORING        — real-time tracking, stall detection, recovery
//
// All data is persisted via the existing planner's serialize/hydrate + DB.

const planner = require('./planner');
const workingMemory = require('./working-memory');
const { logger } = require('../utils/logger');
const { dayjs, fmt } = require('../utils/datetime');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. HIERARCHICAL TASK PLANNING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Break down a complex goal into sub-goals with steps.
 * Uses keyword heuristics + template patterns (LLM can override).
 *
 * @param {string} userId
 * @param {string} goal - the main goal description
 * @param {object} [options]
 * @param {boolean} [options.useLLM=false] - if true, use LLM for decomposition
 * @param {Function} [options.llmChatFn] - LLM chat function (required if useLLM)
 * @returns {Promise<{mainPlan: object, subPlans: Array<object>}>}
 */
async function breakdownGoal(userId, goal, options = {}) {
  const { useLLM = false, llmChatFn } = options;

  // ── Heuristic decomposition ──────────────────────────────────────────
  const decomposition = decomposeHeuristically(goal);

  // Create main plan
  const mainPlan = planner.createPlan(userId, goal, decomposition.mainSteps.map((s, i) => ({
    description: s.text,
    estimatedMinutes: s.estimatedMinutes || 30,
    priority: s.priority || 'medium',
    dependencies: s.dependsOn || [],
    status: 'pending',
  })));

  // Create sub-plans for each sub-goal
  const subPlans = [];
  for (const subGoal of decomposition.subGoals) {
    const subPlan = planner.createPlan(
      userId,
      `[Sub: ${goal.slice(0, 40)}] ${subGoal.text}`,
      subGoal.steps.map((s, i) => ({
        description: s.text,
        estimatedMinutes: s.estimatedMinutes || 20,
        priority: s.priority || 'medium',
        dependencies: s.dependsOn || [],
        status: 'pending',
      }))
    );

    // Tag with parent reference
    subPlan._parentPlanId = mainPlan.planId;
    subPlan._subGoalIndex = subPlans.length;
    subPlans.push(subPlan);
  }

  // Link main plan to sub-plans
  mainPlan._subPlanIds = subPlans.map(p => p.planId);
  mainPlan._decomposed = true;

  // Update working memory
  workingMemory.update(userId, {
    currentGoal: goal,
    addNextStep: `Start sub-goal: ${decomposition.subGoals[0]?.text || 'first step'}`,
  });

  logger.info('[AdvPlanner] 🎯 Goal decomposed', {
    goal: goal.slice(0, 60),
    subGoals: decomposition.subGoals.length,
    totalSteps: decomposition.mainSteps.length + decomposition.subGoals.reduce((s, g) => s + g.steps.length, 0),
  });

  return { mainPlan, subPlans, decomposition };
}

/**
 * Heuristic goal decomposition based on keyword patterns.
 * Returns structured breakdown without LLM calls.
 */
function decomposeHeuristically(goal) {
  const lower = goal.toLowerCase();

  // Pattern: "Learn X in Y weeks"
  const learnMatch = lower.match(/(?:learn|belajar|study)\s+(.+?)(?:\s+in\s+(\d+)\s*(weeks?|days?|months?|bulan|hari|minggu))?$/i);
  if (learnMatch) {
    const topic = learnMatch[1]?.trim() || goal;
    return {
      mainSteps: [
        { text: `Research ${topic} — gather resources & curriculum`, estimatedMinutes: 60, priority: 'high' },
        { text: `Create study schedule for ${topic}`, estimatedMinutes: 30, priority: 'high' },
        { text: `Review progress & adjust plan for ${topic}`, estimatedMinutes: 30, priority: 'medium' },
      ],
      subGoals: [
        {
          text: `Foundations of ${topic}`,
          steps: [
            { text: `Read introductory material on ${topic}`, estimatedMinutes: 90 },
            { text: `Watch beginner tutorials on ${topic}`, estimatedMinutes: 60 },
            { text: `Complete first hands-on exercise for ${topic}`, estimatedMinutes: 60 },
          ],
        },
        {
          text: `Intermediate ${topic}`,
          steps: [
            { text: `Build a small project using ${topic}`, estimatedMinutes: 120 },
            { text: `Study advanced concepts in ${topic}`, estimatedMinutes: 90 },
            { text: `Complete practice exercises for ${topic}`, estimatedMinutes: 60 },
          ],
        },
        {
          text: `Mastery of ${topic}`,
          steps: [
            { text: `Build a portfolio project with ${topic}`, estimatedMinutes: 180 },
            { text: `Teach or document ${topic} knowledge`, estimatedMinutes: 90 },
            { text: `Review & reflect on ${topic} journey`, estimatedMinutes: 45 },
          ],
        },
      ],
    };
  }

  // Pattern: "Build/Create X"
  const buildMatch = lower.match(/(?:build|create|bina|buat|develop)\s+(.+?)(?:\s+(?:for|untuk)\s+(.+))?$/i);
  if (buildMatch) {
    const what = buildMatch[1]?.trim() || goal;
    return {
      mainSteps: [
        { text: `Define requirements for ${what}`, estimatedMinutes: 45, priority: 'high' },
        { text: `Review & launch ${what}`, estimatedMinutes: 60, priority: 'high' },
      ],
      subGoals: [
        {
          text: `Plan ${what}`,
          steps: [
            { text: `Research similar ${what} solutions`, estimatedMinutes: 60 },
            { text: `Create design/architecture for ${what}`, estimatedMinutes: 90 },
            { text: `Set up development environment for ${what}`, estimatedMinutes: 45 },
          ],
        },
        {
          text: `Build ${what}`,
          steps: [
            { text: `Implement core features of ${what}`, estimatedMinutes: 180 },
            { text: `Add supporting features to ${what}`, estimatedMinutes: 120 },
            { text: `Test & debug ${what}`, estimatedMinutes: 90 },
          ],
        },
        {
          text: `Polish ${what}`,
          steps: [
            { text: `Optimize performance of ${what}`, estimatedMinutes: 60 },
            { text: `Add documentation for ${what}`, estimatedMinutes: 45 },
            { text: `Final review of ${what}`, estimatedMinutes: 30 },
          ],
        },
      ],
    };
  }

  // Pattern: "Improve/Optimize/Baiki X"
  const improveMatch = lower.match(/(?:improve|optimize|tingkatkan|baiki|perbaiki)\s+(.+)/i);
  if (improveMatch) {
    const what = improveMatch[1]?.trim() || goal;
    return {
      mainSteps: [
        { text: `Assess current state of ${what}`, estimatedMinutes: 30, priority: 'high' },
        { text: `Implement improvements for ${what}`, estimatedMinutes: 120, priority: 'high' },
        { text: `Measure results & iterate on ${what}`, estimatedMinutes: 45, priority: 'medium' },
      ],
      subGoals: [
        {
          text: `Analyze ${what}`,
          steps: [
            { text: `Gather data/metrics on ${what}`, estimatedMinutes: 45 },
            { text: `Identify bottlenecks in ${what}`, estimatedMinutes: 60 },
          ],
        },
        {
          text: `Execute ${what} improvements`,
          steps: [
            { text: `Apply quick wins for ${what}`, estimatedMinutes: 60 },
            { text: `Implement major changes to ${what}`, estimatedMinutes: 120 },
          ],
        },
      ],
    };
  }

  // Generic fallback: 3-phase decomposition
  return {
    mainSteps: [
      { text: `Plan & prepare for: ${goal}`, estimatedMinutes: 45, priority: 'high' },
      { text: `Execute core work on: ${goal}`, estimatedMinutes: 120, priority: 'high' },
      { text: `Review & finalize: ${goal}`, estimatedMinutes: 45, priority: 'medium' },
    ],
    subGoals: [
      {
        text: `Phase 1 — Setup`,
        steps: [
          { text: `Gather requirements`, estimatedMinutes: 30 },
          { text: `Create initial plan`, estimatedMinutes: 30 },
        ],
      },
      {
        text: `Phase 2 — Execution`,
        steps: [
          { text: `Do the main work`, estimatedMinutes: 120 },
          { text: `Check progress`, estimatedMinutes: 30 },
        ],
      },
      {
        text: `Phase 3 — Completion`,
        steps: [
          { text: `Final review`, estimatedMinutes: 45 },
          { text: `Document results`, estimatedMinutes: 30 },
        ],
      },
    ],
  };
}

/**
 * Get the full hierarchy tree for a plan (main + all sub-plans).
 */
function getPlanHierarchy(userId, planId) {
  const plan = planner.getPlan(userId, planId);
  if (!plan) return null;

  const hierarchy = {
    plan,
    subPlans: [],
  };

  if (plan._subPlanIds) {
    for (const subId of plan._subPlanIds) {
      const sub = getPlanHierarchy(userId, subId);
      if (sub) hierarchy.subPlans.push(sub);
    }
  }

  return hierarchy;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. TEMPORAL REASONING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate total estimated duration for a plan (sum of all steps).
 */
function estimateDuration(plan) {
  if (!plan || !plan.steps) return 0;
  return plan.steps.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
}

/**
 * Calculate estimated completion date based on available time per day.
 * @param {object} plan
 * @param {number} availableMinutesPerDay - how many minutes user can work per day
 * @returns {{totalMinutes: number, estimatedDays: number, estimatedEndDate: string}}
 */
function estimateCompletion(plan, availableMinutesPerDay = 120) {
  const totalMins = estimateDuration(plan);
  // Account for dependencies (sequential steps add up)
  const sequentialMins = calculateCriticalPath(plan);
  const days = Math.ceil(sequentialMins / availableMinutesPerDay);

  const endDate = new Date();
  endDate.setDate(endDate.getDate() + days);

  return {
    totalMinutes: totalMins,
    criticalPathMinutes: sequentialMins,
    estimatedDays: days,
    estimatedEndDate: endDate.toISOString(),
    estimatedEndDateFormatted: fmt(endDate, 'ddd, D MMM YYYY'),
  };
}

/**
 * Calculate the critical path (longest chain of dependent steps).
 */
function calculateCriticalPath(plan) {
  if (!plan || !plan.steps || plan.steps.length === 0) return 0;

  const steps = plan.steps;
  const memo = new Map();

  function dfs(stepIndex) {
    if (memo.has(stepIndex)) return memo.get(stepIndex);

    const step = steps[stepIndex];
    let maxDepTime = 0;

    if (step.dependencies && step.dependencies.length > 0) {
      for (const depId of step.dependencies) {
        const depIndex = steps.findIndex(s => s.id === depId);
        if (depIndex >= 0) {
          maxDepTime = Math.max(maxDepTime, dfs(depIndex));
        }
      }
    }

    const total = maxDepTime + (step.estimatedMinutes || 0);
    memo.set(stepIndex, total);
    return total;
  }

  let maxPath = 0;
  for (let i = 0; i < steps.length; i++) {
    maxPath = Math.max(maxPath, dfs(i));
  }

  return maxPath;
}

/**
 * Detect time conflicts between multiple plans.
 * Two plans conflict if they overlap in estimated time slots.
 *
 * @param {string} userId
 * @returns {Array<{planA: string, planB: string, overlap: string}>}
 */
function detectTimeConflicts(userId) {
  const plans = planner.getPlans(userId).filter(p => p.status === 'active');
  const conflicts = [];

  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const a = plans[i];
      const b = plans[j];

      // Simple heuristic: if both have high-priority steps due soon
      const aHigh = a.steps.filter(s => s.priority === 'high' && s.status === 'pending');
      const bHigh = b.steps.filter(s => s.priority === 'high' && s.status === 'pending');

      if (aHigh.length > 0 && bHigh.length > 0) {
        conflicts.push({
          planA: a.goal.slice(0, 60),
          planB: b.goal.slice(0, 60),
          planAId: a.planId,
          planBId: b.planId,
          overlap: `${aHigh.length} high-priority steps vs ${bHigh.length} high-priority steps`,
        });
      }
    }
  }

  return conflicts;
}

/**
 * Auto-schedule steps considering dependencies and estimated duration.
 * Returns steps in optimal execution order.
 */
function getOptimalStepOrder(plan) {
  if (!plan || !plan.steps) return [];

  const steps = [...plan.steps];
  const completed = new Set(steps.filter(s => s.status === 'completed').map(s => s.id));
  const remaining = steps.filter(s => !completed.has(s.id));

  // Topological sort based on dependencies
  const inDegree = new Map();
  const adj = new Map();

  for (const step of remaining) {
    inDegree.set(step.id, (step.dependencies || []).filter(d => !completed.has(d)).length);
    adj.set(step.id, []);
  }

  for (const step of remaining) {
    for (const other of remaining) {
      if ((other.dependencies || []).includes(step.id)) {
        adj.get(step.id).push(other.id);
      }
    }
  }

  // Kahn's algorithm
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  // Sort by priority within same level
  const priorityScore = { high: 3, medium: 2, low: 1 };
  queue.sort((a, b) => {
    const sa = remaining.find(s => s.id === a);
    const sb = remaining.find(s => s.id === b);
    return (priorityScore[sb?.priority] || 0) - (priorityScore[sa?.priority] || 0);
  });

  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    const step = remaining.find(s => s.id === id);
    if (step) order.push(step);

    for (const nextId of (adj.get(id) || [])) {
      const newDeg = (inDegree.get(nextId) || 1) - 1;
      inDegree.set(nextId, newDeg);
      if (newDeg === 0) {
        queue.push(nextId);
        queue.sort((a, b) => {
          const sa = remaining.find(s => s.id === a);
          const sb = remaining.find(s => s.id === b);
          return (priorityScore[sb?.priority] || 0) - (priorityScore[sa?.priority] || 0);
        });
      }
    }
  }

  return order;
}

/**
 * Get a full timeline view of all active plans.
 */
function getTimeline(userId) {
  const plans = planner.getPlans(userId).filter(p => p.status === 'active');
  const timeline = [];

  for (const plan of plans) {
    const completion = estimateCompletion(plan);
    const nextStep = planner.getNextStep(userId, plan.planId);
    const optimal = getOptimalStepOrder(plan);

    timeline.push({
      planId: plan.planId,
      goal: plan.goal,
      progress: plan.progress,
      totalSteps: plan.steps.length,
      completedSteps: plan.steps.filter(s => s.status === 'completed').length,
      inProgressSteps: plan.steps.filter(s => s.status === 'in_progress').length,
      nextStep: nextStep?.description || null,
      estimatedDays: completion.estimatedDays,
      estimatedEnd: completion.estimatedEndDateFormatted,
      optimalNextSteps: optimal.slice(0, 3).map(s => s.description),
      isStalled: planner.isPlanStalled(userId, plan.planId),
    });
  }

  // Sort by closest deadline (least estimated days first)
  timeline.sort((a, b) => a.estimatedDays - b.estimatedDays);

  return timeline;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. RESOURCE ALLOCATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resource profile for a user (configurable).
 */
const DEFAULT_RESOURCES = {
  maxMinutesPerDay: 240,       // 4 hours max per day
  maxConcurrentPlans: 3,       // max active plans at once
  maxHighPriorityPerDay: 2,    // max high-priority tasks per day
  energyLevel: 0.8,            // 0.0–1.0 (affects effective speed)
};

/**
 * Allocate resources across active plans.
 * Returns utilization report and warnings.
 */
function allocateResources(userId, resources = DEFAULT_RESOURCES) {
  const plans = planner.getPlans(userId).filter(p => p.status === 'active');
  const now = new Date();

  const allocation = {
    plans: [],
    totalAllocatedMinutes: 0,
    totalHighPriority: 0,
    warnings: [],
    withinLimits: true,
  };

  for (const plan of plans) {
    const pendingSteps = plan.steps.filter(s => s.status !== 'completed');
    const totalMins = pendingSteps.reduce((s, step) => s + (step.estimatedMinutes || 0), 0);
    const highPriority = pendingSteps.filter(s => s.priority === 'high').length;

    // Apply energy modifier
    const effectiveMins = Math.ceil(totalMins / (resources.energyLevel || 0.8));

    allocation.plans.push({
      planId: plan.planId,
      goal: plan.goal.slice(0, 60),
      allocatedMinutes: effectiveMins,
      highPriorityTasks: highPriority,
      progress: plan.progress,
    });

    allocation.totalAllocatedMinutes += effectiveMins;
    allocation.totalHighPriority += highPriority;
  }

  // Check limits
  if (allocation.plans.length > resources.maxConcurrentPlans) {
    allocation.warnings.push(
      `${allocation.plans.length} active plans (limit: ${resources.maxConcurrentPlans}). Consider focusing on fewer.`
    );
    allocation.withinLimits = false;
  }

  if (allocation.totalAllocatedMinutes > resources.maxMinutesPerDay) {
    const over = allocation.totalAllocatedMinutes - resources.maxMinutesPerDay;
    allocation.warnings.push(
      `Over-allocated by ${over} minutes/day (${allocation.totalAllocatedMinutes}/${resources.maxMinutesPerDay}).`
    );
    allocation.withinLimits = false;
  }

  if (allocation.totalHighPriority > resources.maxHighPriorityPerDay) {
    allocation.warnings.push(
      `${allocation.totalHighPriority} high-priority tasks (limit: ${resources.maxHighPriorityPerDay}). Prioritize!`
    );
    allocation.withinLimits = false;
  }

  return allocation;
}

/**
 * Suggest rescheduling when over-allocated.
 * Returns plan IDs to pause/defer.
 */
function suggestReschedule(userId) {
  const allocation = allocateResources(userId);

  if (allocation.withinLimits) {
    return { needsReschedule: false, message: 'Resource allocation is within limits. ✅' };
  }

  // Sort plans by progress (keep nearly-done plans, suggest pausing barely-started ones)
  const sorted = [...allocation.plans].sort((a, b) => a.progress - b.progress);

  const toConsider = [];
  let remainingWarnings = [...allocation.warnings];

  for (const plan of sorted) {
    if (plan.progress < 20) {
      toConsider.push({
        planId: plan.planId,
        goal: plan.goal,
        progress: plan.progress,
        suggestion: plan.progress === 0
          ? 'Consider deferring — not yet started.'
          : 'Consider pausing — very early stage.',
      });
    }
  }

  return {
    needsReschedule: true,
    warnings: allocation.warnings,
    suggestions: toConsider.slice(0, 3),
    message: `Over-allocated. ${toConsider.length} plan(s) could be deferred.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. EXECUTION MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execution log entry for monitoring.
 */
const executionLogs = new Map(); // userId → Array<logEntry>

/**
 * Start tracking execution of a plan step.
 */
function startExecution(userId, planId, stepId) {
  const result = planner.startStep(userId, planId, stepId);
  if (!result.success) return result;

  // Record execution start
  const key = `${userId}:${planId}`;
  if (!executionLogs.has(key)) executionLogs.set(key, []);

  executionLogs.get(key).push({
    type: 'start',
    stepId,
    timestamp: new Date().toISOString(),
    estimatedMinutes: result.startedStep?.estimatedMinutes || 0,
  });

  // Update working memory
  workingMemory.update(userId, {
    currentProblem: `Executing step: ${result.startedStep?.description || `#${stepId}`}`,
  });

  return result;
}

/**
 * Complete execution of a plan step and log it.
 */
function completeExecution(userId, planId, stepId) {
  const result = planner.completeStep(userId, planId, stepId);
  if (!result.success) return result;

  // Record completion
  const key = `${userId}:${planId}`;
  if (!executionLogs.has(key)) executionLogs.set(key, []);

  const startEntry = executionLogs.get(key).findLast(e => e.type === 'start' && e.stepId === stepId);
  const duration = startEntry
    ? Math.round((Date.now() - new Date(startEntry.timestamp).getTime()) / 60000)
    : null;

  executionLogs.get(key).push({
    type: 'complete',
    stepId,
    timestamp: new Date().toISOString(),
    durationMinutes: duration,
    onTime: duration !== null ? duration <= (startEntry?.estimatedMinutes || 30) * 1.5 : null,
  });

  // If plan fully completed, log it
  if (result.plan && result.plan.status === 'completed') {
    executionLogs.get(key).push({
      type: 'plan_complete',
      timestamp: new Date().toISOString(),
      totalSteps: result.plan.steps.length,
    });
  }

  return result;
}

/**
 * Check execution progress and detect stalls.
 */
function checkProgress(userId) {
  const plans = planner.getPlans(userId).filter(p => p.status === 'active');
  const report = {
    healthy: [],
    stalled: [],
    delayed: [],
    atRisk: [],
  };

  for (const plan of plans) {
    const timeline = estimateCompletion(plan);
    const inProgress = plan.steps.filter(s => s.status === 'in_progress');
    const stalled = planner.isPlanStalled(userId, plan.planId);

    if (stalled) {
      report.stalled.push({
        planId: plan.planId,
        goal: plan.goal.slice(0, 60),
        progress: plan.progress,
        lastUpdated: plan.updatedAt,
        stalledHours: Math.round((Date.now() - new Date(plan.updatedAt).getTime()) / 3600000),
      });
      continue;
    }

    // Check for delayed in-progress steps
    for (const step of inProgress) {
      if (step.startedAt) {
        const elapsed = (Date.now() - new Date(step.startedAt).getTime()) / 60000;
        const estimated = step.estimatedMinutes || 30;
        if (elapsed > estimated * 2) {
          report.delayed.push({
            planId: plan.planId,
            stepId: step.id,
            description: step.description,
            elapsed: Math.round(elapsed),
            estimated,
          });
        }
      }
    }

    // At-risk: <30% progress and no recent activity
    if (plan.progress < 30) {
      const daysOld = (Date.now() - new Date(plan.createdAt).getTime()) / (24 * 60 * 60 * 1000);
      if (daysOld > 3) {
        report.atRisk.push({
          planId: plan.planId,
          goal: plan.goal.slice(0, 60),
          progress: plan.progress,
          daysOld: Math.round(daysOld),
        });
      }
    }

    if (!stalled && report.delayed.length === 0 && (!report.atRisk.find(r => r.planId === plan.planId))) {
      report.healthy.push({
        planId: plan.planId,
        goal: plan.goal.slice(0, 60),
        progress: plan.progress,
        nextStep: planner.getNextStep(userId, plan.planId)?.description || 'all done',
      });
    }
  }

  return report;
}

/**
 * Generate recovery suggestions when execution is failing.
 */
function generateRecoveryPlan(userId, planId) {
  const plan = planner.getPlan(userId, planId);
  if (!plan) return { error: 'Plan not found' };

  const progress = checkProgress(userId);
  const planStatus = [
    ...progress.stalled,
    ...progress.delayed.filter(d => d.planId === planId),
    ...progress.atRisk.filter(r => r.planId === planId),
  ];

  if (planStatus.length === 0) {
    return {
      needsRecovery: false,
      message: 'No issues detected. Plan is on track. ✅',
    };
  }

  const recovery = {
    needsRecovery: true,
    planId,
    goal: plan.goal,
    issues: [],
    suggestions: [],
  };

  // Analyze issues
  const stalledInfo = progress.stalled.find(s => s.planId === planId);
  if (stalledInfo) {
    recovery.issues.push(`Stalled for ${stalledInfo.stalledHours}h`);
    recovery.suggestions.push('Break the next step into smaller sub-steps (5-15 min each).');
    recovery.suggestions.push('Set a specific time today to work on this for just 10 minutes.');
    recovery.suggestions.push('Review if this goal is still a priority — consider abandoning if not.');
  }

  const delayedSteps = progress.delayed.filter(d => d.planId === planId);
  for (const d of delayedSteps) {
    recovery.issues.push(`Step #${d.stepId} "${d.description}" taking ${d.elapsed}min (estimated ${d.estimated}min)`);
    recovery.suggestions.push(`Re-estimate step #${d.stepId} — actual time may be ${Math.round(d.elapsed / 60 * 10) / 10}h.`);
    recovery.suggestions.push(`Consider splitting step #${d.stepId} into smaller chunks.`);
  }

  const atRiskInfo = progress.atRisk.find(r => r.planId === planId);
  if (atRiskInfo) {
    recovery.issues.push(`At risk — ${atRiskInfo.progress}% after ${atRiskInfo.daysOld} days`);
    recovery.suggestions.push('Schedule a 25-minute focused session (Pomodoro) for this plan today.');
  }

  // Deduplicate suggestions
  recovery.suggestions = [...new Set(recovery.suggestions)];

  // Update working memory with recovery context
  workingMemory.update(userId, {
    currentProblem: `Plan "${plan.goal.slice(0, 40)}" needs recovery`,
    addSolution: recovery.suggestions[0] || 'Review plan priority',
  });

  return recovery;
}

/**
 * Full execution audit log for a plan.
 */
function executionAudit(userId, planId) {
  const key = `${userId}:${planId}`;
  const logs = executionLogs.get(key) || [];
  const plan = planner.getPlan(userId, planId);

  if (!plan) return { error: 'Plan not found' };

  const startEvents = logs.filter(l => l.type === 'start');
  const completeEvents = logs.filter(l => l.type === 'complete');
  const planComplete = logs.find(l => l.type === 'plan_complete');

  // Calculate metrics
  const totalEstimated = plan.steps.reduce((s, step) => s + (step.estimatedMinutes || 0), 0);
  const totalActual = completeEvents.reduce((s, e) => s + (e.durationMinutes || 0), 0);
  const onTimeCount = completeEvents.filter(e => e.onTime === true).length;
  const lateCount = completeEvents.filter(e => e.onTime === false).length;

  return {
    planId,
    goal: plan.goal,
    status: plan.status,
    progress: plan.progress,
    stepsTotal: plan.steps.length,
    stepsStarted: startEvents.length,
    stepsCompleted: completeEvents.length,
    estimatedTotalMin: totalEstimated,
    actualTotalMin: totalActual,
    efficiency: totalEstimated > 0 ? Math.round((totalEstimated / Math.max(totalActual, 1)) * 100) : null,
    onTimeSteps: onTimeCount,
    lateSteps: lateCount,
    completedAt: planComplete?.timestamp || null,
    logs: logs.slice(-20), // last 20 events
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Hierarchical Planning
  breakdownGoal,
  decomposeHeuristically,
  getPlanHierarchy,

  // Temporal Reasoning
  estimateDuration,
  estimateCompletion,
  calculateCriticalPath,
  detectTimeConflicts,
  getOptimalStepOrder,
  getTimeline,

  // Resource Allocation
  allocateResources,
  suggestReschedule,
  DEFAULT_RESOURCES,

  // Execution Monitoring
  startExecution,
  completeExecution,
  checkProgress,
  generateRecoveryPlan,
  executionAudit,
};
