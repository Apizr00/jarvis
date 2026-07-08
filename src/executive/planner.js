// src/executive/planner.js
// ── Planning Layer (Fasa 4) ────────────────────────────────────────────────
// Intelligent task decomposition, multi-step planning, and progress tracking.
//
// Capabilities:
//   - Break down goals into actionable steps
//   - Track dependencies between steps
//   - Estimate time and effort for each step
//   - Prioritize based on urgency and importance
//   - Adapt plans based on progress
//   - Suggest next best action

const db = require('../db');
const workingMemory = require('./working-memory');

// ── Plan Schema ─────────────────────────────────────────────────────────────

/**
 * A plan is a structured breakdown of a goal into steps.
 * {
 *   planId: string,
 *   goal: string,
 *   steps: [{
 *     id: number,
 *     description: string,
 *     estimatedMinutes: number,
 *     priority: 'high'|'medium'|'low',
 *     dependencies: number[],    // step IDs that must be done first
 *     status: 'pending'|'in_progress'|'completed'|'blocked',
 *     startedAt: ISO string,
 *     completedAt: ISO string,
 *   }],
 *   createdAt: ISO string,
 *   updatedAt: ISO string,
 *   status: 'active'|'completed'|'abandoned',
 *   progress: 0-100,
 * }
 */

// ── In-memory plan store (backed by DB for persistence) ────────────────────
const planStore = new Map(); // userId → plans[]

/**
 * Create a new plan for a goal.
 * @param {string} userId
 * @param {string} goal - the goal description
 * @param {Array<{description: string, estimatedMinutes?: number, priority?: string, dependencies?: number[]}>} steps
 * @returns {object} the created plan
 */
function createPlan(userId, goal, steps = []) {
  const plans = getPlans(userId);

  const planId = 'plan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  const plan = {
    planId,
    goal,
    steps: steps.map((s, i) => ({
      id: i + 1,
      description: s.description,
      estimatedMinutes: s.estimatedMinutes || 30,
      priority: s.priority || 'medium',
      dependencies: s.dependencies || [],
      status: 'pending',
      startedAt: null,
      completedAt: null,
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
    progress: 0,
  };

  plans.push(plan);

  // Update working memory with plan context
  workingMemory.update(userId, {
    currentGoal: goal,
    contextNotes: 'Plan created for: ' + goal,
  });
  // Add each step individually
  for (const step of plan.steps.filter(s => s.status === 'pending').slice(0, 3)) {
    workingMemory.update(userId, { addNextStep: step.description });
  }

  console.log('[Planner] 📋 Plan created: ' + planId + ' — ' + goal + ' (' + plan.steps.length + ' steps)');
  return plan;
}

/**
 * Get all active plans for a user.
 */
function getPlans(userId) {
  if (!planStore.has(userId)) {
    planStore.set(userId, []);
  }
  return planStore.get(userId);
}

/**
 * Get a specific plan by ID.
 */
function getPlan(userId, planId) {
  return getPlans(userId).find(p => p.planId === planId);
}

/**
 * Get the currently active plan (most recently created/updated).
 */
function getActivePlan(userId) {
  const plans = getPlans(userId).filter(p => p.status === 'active');
  if (plans.length === 0) return null;
  return plans.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
}

/**
 * Complete a step in a plan.
 * Automatically unblocks dependent steps.
 */
function completeStep(userId, planId, stepId) {
  const plan = getPlan(userId, planId);
  if (!plan) return { error: 'Plan not found' };

  const step = plan.steps.find(s => s.id === stepId);
  if (!step) return { error: 'Step not found' };

  step.status = 'completed';
  step.completedAt = new Date().toISOString();
  plan.updatedAt = new Date().toISOString();

  // Unblock dependent steps
  for (const s of plan.steps) {
    if (s.status === 'pending' && s.dependencies.includes(stepId)) {
      // Check if ALL dependencies are completed
      const allDepsMet = s.dependencies.every(depId => {
        const dep = plan.steps.find(d => d.id === depId);
        return dep && dep.status === 'completed';
      });
      if (allDepsMet) {
        s.status = 'pending'; // ready to start
      }
    }
  }

  // Update progress
  updatePlanProgress(plan);

  // Update working memory
  workingMemory.update(userId, {
    completeNextStep: step.description,
    contextNotes: 'Completed step ' + stepId + ' of plan: ' + plan.goal,
  });

  console.log('[Planner] ✅ Step completed: ' + planId + ' step ' + stepId);

  return { success: true, plan, completedStep: step };
}

/**
 * Start working on a step.
 */
function startStep(userId, planId, stepId) {
  const plan = getPlan(userId, planId);
  if (!plan) return { error: 'Plan not found' };

  const step = plan.steps.find(s => s.id === stepId);
  if (!step) return { error: 'Step not found' };

  // Check dependencies
  for (const depId of step.dependencies) {
    const dep = plan.steps.find(d => d.id === depId);
    if (!dep || dep.status !== 'completed') {
      return { error: 'Dependency not completed: step ' + depId, blockedBy: depId };
    }
  }

  step.status = 'in_progress';
  step.startedAt = new Date().toISOString();
  plan.updatedAt = new Date().toISOString();

  workingMemory.update(userId, {
    currentProblem: step.description,
    contextNotes: 'Started step ' + stepId + ' of: ' + plan.goal,
  });

  console.log('[Planner] ▶️ Step started: ' + planId + ' step ' + stepId);
  return { success: true, plan, startedStep: step };
}

/**
 * Mark a plan as completed.
 */
function completePlan(userId, planId) {
  const plan = getPlan(userId, planId);
  if (!plan) return { error: 'Plan not found' };

  plan.status = 'completed';
  plan.progress = 100;
  plan.updatedAt = new Date().toISOString();

  // Mark all remaining steps as completed
  for (const step of plan.steps) {
    if (step.status !== 'completed') {
      step.status = 'completed';
      step.completedAt = new Date().toISOString();
    }
  }

  // Reset working memory for this goal
  workingMemory.update(userId, {
    currentGoal: '',
    currentProblem: '',
    contextNotes: 'Plan completed: ' + plan.goal,
  });

  console.log('[Planner] 🏆 Plan completed: ' + planId + ' — ' + plan.goal);
  return { success: true, plan };
}

/**
 * Abandon a plan.
 */
function abandonPlan(userId, planId, reason = '') {
  const plan = getPlan(userId, planId);
  if (!plan) return { error: 'Plan not found' };

  plan.status = 'abandoned';
  plan.updatedAt = new Date().toISOString();

  // Record reason in working memory as rejected idea
  if (reason) {
    workingMemory.update(userId, {
      rejectSolution: 'Plan abandoned: ' + plan.goal + (reason ? ' — ' + reason : ''),
      contextNotes: 'Abandoned plan: ' + plan.goal,
    });
  }

  console.log('[Planner] 🗑️ Plan abandoned: ' + planId + ' — ' + plan.goal);
  return { success: true, plan };
}

/**
 * Update the progress percentage of a plan.
 */
function updatePlanProgress(plan) {
  if (!plan.steps || plan.steps.length === 0) {
    plan.progress = 0;
    return;
  }

  const completed = plan.steps.filter(s => s.status === 'completed').length;
  const inProgress = plan.steps.filter(s => s.status === 'in_progress').length;

  plan.progress = Math.round(((completed + inProgress * 0.5) / plan.steps.length) * 100);
}

/**
 * Get the next actionable step (first pending with all deps met).
 */
function getNextStep(userId, planId) {
  const plan = getPlan(userId, planId);
  if (!plan) return null;

  for (const step of plan.steps) {
    if (step.status !== 'pending') continue;

    const allDepsMet = step.dependencies.every(depId => {
      const dep = plan.steps.find(d => d.id === depId);
      return dep && dep.status === 'completed';
    });

    if (allDepsMet) return step;
  }

  return null; // all done or blocked
}

/**
 * Generate a plan summary for LLM context.
 */
function formatPlanForPrompt(userId) {
  const activePlan = getActivePlan(userId);
  if (!activePlan) return '';

  const parts = ['📋 PLAN: ' + activePlan.goal];
  parts.push('Progress: ' + activePlan.progress + '%');

  for (const step of activePlan.steps) {
    const statusIcons = {
      pending: '⏳',
      in_progress: '▶️',
      completed: '✅',
      blocked: '🚫',
    };
    const icon = statusIcons[step.status] || '❓';
    const deps = step.dependencies.length > 0
      ? ' (needs: step ' + step.dependencies.join(', ') + ')'
      : '';
    parts.push('  ' + icon + ' Step ' + step.id + ': ' + step.description + deps);
  }

  return 'ACTIVE PLAN ────────────────────────\n' + parts.join('\n');
}

/**
 * Check if a plan is stalled (no steps completed in X hours).
 */
function isPlanStalled(userId, planId, hoursThreshold = 24) {
  const plan = getPlan(userId, planId);
  if (!plan || plan.status !== 'active') return false;

  const threshold = hoursThreshold * 60 * 60 * 1000;
  const lastUpdate = new Date(plan.updatedAt).getTime();

  return (Date.now() - lastUpdate) > threshold;
}

/**
 * Get all stalled plans for a user.
 */
function getStalledPlans(userId, hoursThreshold = 24) {
  return getPlans(userId).filter(p =>
    p.status === 'active' && isPlanStalled(userId, p.planId, hoursThreshold)
  );
}

/**
 * Suggest the next best action across all active plans.
 */
function suggestNextAction(userId) {
  const activePlans = getPlans(userId).filter(p => p.status === 'active');
  if (activePlans.length === 0) return null;

  const suggestions = [];

  for (const plan of activePlans) {
    const nextStep = getNextStep(userId, plan.planId);
    if (nextStep) {
      suggestions.push({
        planId: plan.planId,
        goal: plan.goal,
        step: nextStep,
        progress: plan.progress,
      });
    }
  }

  if (suggestions.length === 0) return null;

  // Prioritize: high priority steps first, then by progress (lower = more urgent)
  suggestions.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const pa = priorityOrder[a.step.priority] || 1;
    const pb = priorityOrder[b.step.priority] || 1;
    if (pa !== pb) return pa - pb;
    return a.progress - b.progress;
  });

  return suggestions[0];
}

module.exports = {
  createPlan,
  getPlans,
  getPlan,
  getActivePlan,
  completeStep,
  startStep,
  completePlan,
  abandonPlan,
  getNextStep,
  formatPlanForPrompt,
  isPlanStalled,
  getStalledPlans,
  suggestNextAction,
  // Persistence
  serialize,
  hydrate,
};

/**
 * Serialize planner state for DB persistence.
 * Only saves active plans (completed/abandoned are historical).
 * @param {string} userId
 * @returns {object|null}
 */
function serialize(userId) {
  const plans = planStore.get(userId);
  if (!plans || plans.length === 0) return null;

  // Only persist active plans
  const activePlans = plans.filter(p => p.status === 'active');
  if (activePlans.length === 0) return null;

  return {
    plans: activePlans,
    totalPlans: plans.length,
    activeCount: activePlans.length,
  };
}

/**
 * Hydrate planner state from persisted DB data.
 * @param {string} userId
 * @param {object} data
 */
function hydrate(userId, data) {
  if (!data || !data.plans || data.plans.length === 0) return;

  const existingPlans = planStore.get(userId) || [];

  // Keep historical (completed/abandoned) plans, replace active ones
  const historicalPlans = existingPlans.filter(p => p.status !== 'active');
  const restoredPlans = data.plans.filter(p => p.status === 'active');

  planStore.set(userId, [...historicalPlans, ...restoredPlans]);

  console.log('[Planner] 💧 Hydrated from DB (' + restoredPlans.length + ' active plans restored, ' + historicalPlans.length + ' historical kept)');
}
