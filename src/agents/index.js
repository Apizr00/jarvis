// src/agents/index.js
// ── Agent Layer ──────────────────────────────────────────────────────────────
//
// Agents are autonomous task-execution units that sit ABOVE tools.
// While tools are single-purpose (create_reminder, add_note, etc.),
// agents orchestrate multiple tools + LLM calls to accomplish multi-step
// goals independently.
//
// Each agent has:
//   - A defined capability (what it can do)
//   - Internal state (what it's currently doing)
//   - Validation logic (guardrails against hallucination)
//   - Error recovery (retry, fallback, graceful degradation)
//   - Telemetry hooks (event bus integration)
//
// Agent hierarchy:
//
//   ┌─────────────────────────────────────────────────────┐
//   │                   Executive                         │
//   │  (intent → decide which agent should handle this)    │
//   └──────────┬──────────┬──────────┬───────────────────┘
//              │          │          │
//     ┌────────▼──┐ ┌────▼────┐ ┌───▼──────┐
//     │  Memory   │ │  Task   │ │ Reminder │  ...
//     │  Agent    │ │  Agent  │ │  Agent   │
//     └───────────┘ └─────────┘ └──────────┘
//
// Agent lifecycle:
//   register → idle → task_received → validating → executing → done/error → idle

const { eventBus, EVENTS } = require('../events');
const db = require('../db');
const trace = require('../utils/trace');

// ── Base Agent ───────────────────────────────────────────────────────────────

class Agent {
  /**
   * @param {object} config
   * @param {string} config.name - unique agent name (e.g., 'memory', 'task')
   * @param {string} config.description - what this agent does
   * @param {string[]} config.capabilities - list of capability strings
   * @param {string[]} [config.requires] - dependencies (other agent names)
   * @param {number} [config.maxRetries=3] - max retries on failure
   * @param {number} [config.timeoutMs=30000] - max execution time
   */
  constructor(config) {
    this.name = config.name;
    this.description = config.description;
    this.capabilities = config.capabilities || [];
    this.requires = config.requires || [];
    this.maxRetries = config.maxRetries || 3;
    this.timeoutMs = config.timeoutMs || 30000;

    /** @type {'idle'|'running'|'error'|'disabled'} */
    this.status = 'idle';
    this.currentTask = null;
    this.taskHistory = [];       // last N tasks executed
    this.maxHistorySize = 50;
    this.retryCount = 0;
    this.totalTasksCompleted = 0;
    this.totalTasksFailed = 0;
    this._initialized = false;
  }

  // ── Lifecycle (override in subclasses) ──────────────────────────────────

  /** Called once when the agent is registered. Use for setup. */
  async init() {
    this._initialized = true;
    console.log('[Agent:' + this.name + '] Initialized');
  }

  /**
   * Main execution method. Override in subclasses.
   * @param {object} task - { userId, action, params, context }
   * @returns {Promise<{success: boolean, result?: any, error?: string}>}
   */
  async execute(task) {
    throw new Error('Agent.execute() must be implemented by subclass');
  }

  /** Validate a task before execution. Override for agent-specific checks. */
  async validate(task) {
    // Default: check that required params exist based on action
    if (!task.userId) return { valid: false, error: 'Missing userId' };
    if (!task.action) return { valid: false, error: 'Missing action' };
    return { valid: true };
  }

  /** Called when the agent is being shut down. */
  async cleanup() {
    this.status = 'idle';
    this.currentTask = null;
  }

  // ── Task Execution ─────────────────────────────────────────────────────

  /**
   * Run a task through the full pipeline: validate → execute → record.
   * This is the main entry point called by the AgentRegistry.
   */
  async runTask(task) {
    const taskSpan = trace.startSpan('agent_' + this.name + '_execute', {
      agent: this.name,
      action: task.action,
      userId: task.userId,
    });

    this.status = 'running';
    this.currentTask = { ...task, startedAt: new Date().toISOString() };
    this.retryCount = 0;

    // Emit agent task started event
    eventBus.emitSync(EVENTS.AGENT_TASK_STARTED, {
      agent: this.name,
      action: task.action,
      userId: task.userId,
      timestamp: new Date().toISOString(),
    });

    let result;
    try {
      // ── Validate ────────────────────────────────────────────────────
      const validation = await this._withTimeout(
        this.validate(task),
        this.timeoutMs / 3
      );
      if (!validation.valid) {
        throw new Error('Validation failed: ' + validation.error);
      }

      // ── Execute with retry ──────────────────────────────────────────
      result = await this._executeWithRetry(task);

      // Success
      this.totalTasksCompleted++;
      this._recordTaskHistory(task, { success: true, result });
      taskSpan.end({ success: true });

      eventBus.emitSync(EVENTS.AGENT_TASK_COMPLETED, {
        agent: this.name,
        action: task.action,
        userId: task.userId,
        success: true,
        durationMs: taskSpan.durationMs,
      });

      return { success: true, result };

    } catch (err) {
      // Failure
      this.totalTasksFailed++;
      this._recordTaskHistory(task, { success: false, error: err.message });
      taskSpan.end({ success: false, error: err.message });

      eventBus.emitSync(EVENTS.AGENT_TASK_COMPLETED, {
        agent: this.name,
        action: task.action,
        userId: task.userId,
        success: false,
        error: err.message,
        durationMs: taskSpan.durationMs,
      });

      return { success: false, error: err.message };

    } finally {
      this.status = 'idle';
      this.currentTask = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  async _executeWithRetry(task) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        this.retryCount = attempt;
        const delay = Math.min(1000 * Math.pow(2, attempt), 15000); // exponential backoff, capped at 15s
        console.log('[Agent:' + this.name + '] Retry ' + attempt + '/' + this.maxRetries + ' (waiting ' + delay + 'ms)');
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      try {
        const result = await this._withTimeout(
          this.execute({ ...task, attempt }),
          this.timeoutMs
        );
        return result;
      } catch (err) {
        lastError = err;
        if (err.message.includes('timeout')) {
          console.warn('[Agent:' + this.name + '] Timeout on attempt ' + (attempt + 1));
        }
      }
    }

    throw new Error(
      'Agent "' + this.name + '" failed after ' + (this.maxRetries + 1) +
      ' attempts. Last error: ' + (lastError?.message || 'unknown')
    );
  }

  async _withTimeout(promiseOrValue, ms) {
    if (promiseOrValue && typeof promiseOrValue.then === 'function') {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Agent timeout after ' + ms + 'ms')), ms)
      );
      return Promise.race([promiseOrValue, timeout]);
    }
    return promiseOrValue;
  }

  _recordTaskHistory(task, outcome) {
    this.taskHistory.push({
      action: task.action,
      userId: task.userId,
      params: task.params ? JSON.stringify(task.params).slice(0, 200) : null,
      success: outcome.success,
      error: outcome.error || null,
      timestamp: new Date().toISOString(),
    });
    while (this.taskHistory.length > this.maxHistorySize) {
      this.taskHistory.shift();
    }
  }

  /** Get agent status for monitoring/API. */
  getStatus() {
    return {
      name: this.name,
      description: this.description,
      status: this.status,
      capabilities: this.capabilities,
      initialized: this._initialized,
      totalCompleted: this.totalTasksCompleted,
      totalFailed: this.totalTasksFailed,
      currentTask: this.currentTask ? {
        action: this.currentTask.action,
        startedAt: this.currentTask.startedAt,
      } : null,
      recentTasks: this.taskHistory.slice(-5),
    };
  }
}

// ── Memory Agent ────────────────────────────────────────────────────────────

/**
 * Handles all memory-related operations: storing facts, retrieving context,
 * managing relationships, pruning stale data.
 */
class MemoryAgent extends Agent {
  constructor() {
    super({
      name: 'memory',
      description: 'Manages persistent user memory — facts, relationships, and knowledge retrieval',
      capabilities: [
        'memory:store_fact',
        'memory:retrieve_context',
        'memory:update_fact',
        'memory:forget_fact',
        'memory:find_related',
        'memory:summarize_knowledge',
      ],
    });
  }

  async init() {
    await super.init();
    // Subscribe to events that affect memory
    eventBus.on(EVENTS.MESSAGE_RECEIVED, (payload) => {
      // Auto-extract facts from messages (fire-and-forget)
      this._autoExtractFacts(payload).catch(err =>
        console.warn('[MemoryAgent] Auto-extract error:', err.message)
      );
    }, { priority: -10 });
  }

  async validate(task) {
    const base = await super.validate(task);
    if (!base.valid) return base;

    const validActions = this.capabilities.map(c => c.replace('memory:', ''));
    if (!validActions.includes(task.action)) {
      return { valid: false, error: 'Unknown action: ' + task.action };
    }

    return { valid: true };
  }

  async execute(task) {
    const memory = require('../memory');
    const relationships = require('../memory/relationships');
    const domains = require('../memory/domains');

    switch (task.action) {
      case 'store_fact':
        return this._storeFact(task, memory);
      case 'retrieve_context':
        return this._retrieveContext(task, memory, relationships, domains);
      case 'update_fact':
        return this._updateFact(task, memory);
      case 'forget_fact':
        return this._forgetFact(task, memory);
      case 'find_related':
        return this._findRelated(task, memory, relationships);
      case 'summarize_knowledge':
        return this._summarizeKnowledge(task, memory);
      default:
        throw new Error('Unhandled action: ' + task.action);
    }
  }

  async _storeFact(task, memory) {
    const { key, value, confidence } = task.params || {};
    if (!key || !value) throw new Error('store_fact requires key and value');

    const fact = await memory.setFact(task.userId, key, value, { confidence });
    eventBus.emitSync(EVENTS.MEMORY_UPDATED, {
      userId: task.userId,
      key,
      value: value.slice(0, 100),
    });
    return { fact, message: 'Fact stored: ' + key };
  }

  async _retrieveContext(task, memory, relationships, domains) {
    const { query, limit } = task.params || {};
    const searchQuery = query || task.context?.userMessage || '';

    const [facts, rels, domainCtx] = await Promise.all([
      memory.searchFacts(task.userId, searchQuery, limit || 5),
      relationships.getRelevant(task.userId, searchQuery),
      domains.getDomainContext(task.userId),
    ]);

    return {
      facts,
      relationships: rels,
      domainContext: domainCtx,
      formattedForPrompt: memory.formatMemoryForPrompt(facts, rels),
    };
  }

  async _updateFact(task, memory) {
    const { key, value } = task.params || {};
    if (!key) throw new Error('update_fact requires key');
    const fact = await memory.setFact(task.userId, key, value, { merge: true });
    return { fact, message: 'Fact updated: ' + key };
  }

  async _forgetFact(task, memory) {
    const { key } = task.params || {};
    if (!key) throw new Error('forget_fact requires key');
    await memory.deleteFact(task.userId, key);
    eventBus.emitSync(EVENTS.MEMORY_FORGOTTEN, {
      userId: task.userId,
      key,
    });
    return { message: 'Fact forgotten: ' + key };
  }

  async _findRelated(task, memory, relationships) {
    const { key } = task.params || {};
    const related = await relationships.findConnections(task.userId, key);
    return { related, count: related.length };
  }

  async _summarizeKnowledge(task, memory) {
    const summary = await memory.getKnowledgeSummary(task.userId);
    return { summary };
  }

  async _autoExtractFacts(payload) {
    // Lightweight keyword-based extraction (no LLM)
    // Future: use MiMo for more sophisticated extraction
    const { userId, text } = payload;
    if (!userId || !text || text.length < 10) return;

    const memory = require('../memory');
    const patterns = [
      // "My name is X" → name
      { regex: /(?:my\s+)?name\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i, key: 'name' },
      // "Saya tinggal di X" → location
      { regex: /(?:saya\s+)?tinggal\s+di\s+(.+)/i, key: 'location' },
      // "Saya kerja sebagai X" → occupation
      { regex: /(?:saya\s+)?kerja\s+sebagai\s+(.+)/i, key: 'occupation' },
      // "Saya suka X" → preference
      { regex: /(?:saya\s+)?suka\s+(.+)/i, key: 'likes' },
      // "Saya selalu X pukul Y" → routine
      { regex: /(?:saya\s+)?selalu\s+(.+?)\s+pukul\s+(\d{1,2}(?:[:.]\d{2})?)/i, key: 'routine' },
    ];

    for (const { regex, key } of patterns) {
      const match = text.match(regex);
      if (match) {
        const value = match[1] + (match[2] ? ' at ' + match[2] : '');
        await memory.setFact(userId, key, value.trim(), { confidence: 3, source: 'auto-extract' });
      }
    }
  }
}

// ── Task Agent ──────────────────────────────────────────────────────────────

/**
 * Manages task lifecycle: creation, tracking, completion, goal alignment.
 */
class TaskAgent extends Agent {
  constructor() {
    super({
      name: 'task',
      description: 'Manages task lifecycle — creation, tracking, completion, and goal alignment',
      capabilities: [
        'task:create',
        'task:update',
        'task:start',
        'task:complete',
        'task:cancel',
        'task:list',
        'task:prioritize',
        'task:link_to_goal',
      ],
    });
  }

  async validate(task) {
    const base = await super.validate(task);
    if (!base.valid) return base;

    // Validate task-specific params
    const { params } = task;
    switch (task.action) {
      case 'create':
        if (!params?.title) return { valid: false, error: 'Task title is required' };
        break;
      case 'update':
      case 'start':
      case 'complete':
      case 'cancel':
        if (!params?.task_id) return { valid: false, error: 'task_id is required' };
        break;
      case 'link_to_goal':
        if (!params?.task_id || !params?.goal_id) return { valid: false, error: 'task_id and goal_id required' };
        break;
    }

    return { valid: true };
  }

  async execute(task) {
    switch (task.action) {
      case 'create': {
        const { title, description, priority, due_date, goal_id } = task.params || {};
        const result = await db.createTask(task.userId, { title, description, priority, due_date, goal_id });
        return { task: result, message: 'Task created: ' + title };
      }
      case 'update': {
        const { task_id, ...updates } = task.params || {};
        const result = await db.updateTask(task.userId, task_id, updates);
        return { task: result, message: 'Task updated' };
      }
      case 'start': {
        const { task_id } = task.params || {};
        await db.startTask(task.userId, task_id);
        return { message: 'Task started' };
      }
      case 'complete': {
        const { task_id } = task.params || {};
        await db.completeTask(task.userId, task_id);
        return { message: 'Task completed 🎉' };
      }
      case 'cancel': {
        const { task_id } = task.params || {};
        await db.cancelTask(task.userId, task_id);
        return { message: 'Task cancelled' };
      }
      case 'list': {
        const { status } = task.params || {};
        const tasks = await db.listTasks(task.userId, status);
        return { tasks, count: tasks.length };
      }
      case 'prioritize': {
        const tasks = await db.listTasks(task.userId, 'pending');
        const prioritized = this._prioritizeTasks(tasks);
        return { prioritized, strategy: 'urgency-importance matrix' };
      }
      case 'link_to_goal': {
        const { task_id, goal_id } = task.params || {};
        await db.linkTaskToGoal(task.userId, task_id, goal_id);
        return { message: 'Task linked to goal' };
      }
      default:
        throw new Error('Unhandled action: ' + task.action);
    }
  }

  _prioritizeTasks(tasks) {
    return tasks
      .map(t => {
        let score = 0;
        if (t.priority === 'high') score += 30;
        if (t.priority === 'medium') score += 15;
        if (t.due_date) {
          const daysUntilDue = (new Date(t.due_date) - new Date()) / (1000 * 60 * 60 * 24);
          if (daysUntilDue < 1) score += 40;
          else if (daysUntilDue < 3) score += 25;
          else if (daysUntilDue < 7) score += 10;
        }
        if (t.goal_id) score += 20; // linked to goal = more important
        return { ...t, priorityScore: score };
      })
      .sort((a, b) => b.priorityScore - a.priorityScore);
  }
}

// ── Reminder Agent ──────────────────────────────────────────────────────────

/**
 * Handles reminder operations with anti-hallucination guards.
 */
class ReminderAgent extends Agent {
  constructor() {
    super({
      name: 'reminder',
      description: 'Manages reminders with anti-hallucination validation',
      capabilities: [
        'reminder:create',
        'reminder:update',
        'reminder:cancel',
        'reminder:list',
        'reminder:get_today',
        'reminder:validate_time',
      ],
    });
  }

  async execute(task) {
    switch (task.action) {
      case 'create': {
        const { text, time, recurrence } = task.params || {};
        if (!text || !time) throw new Error('create requires text and time');
        const reminder = await db.createReminder(task.userId, text, time, recurrence);
        eventBus.emitSync(EVENTS.REMINDER_CREATED, {
          userId: task.userId,
          reminderId: reminder.id,
          text,
          time,
        });
        return { reminder, message: 'Reminder created: ' + text };
      }
      case 'update': {
        const { reminder_id, ...updates } = task.params || {};
        const reminder = await db.updateReminder(task.userId, reminder_id, updates);
        return { reminder, message: 'Reminder updated' };
      }
      case 'cancel': {
        const { reminder_id } = task.params || {};
        await db.cancelReminder(task.userId, reminder_id);
        return { message: 'Reminder cancelled' };
      }
      case 'list': {
        const reminders = await db.getAllReminders(task.userId);
        return { reminders, count: reminders.length };
      }
      case 'get_today': {
        const reminders = await db.getTodayReminders(task.userId);
        return { reminders, count: reminders.length };
      }
      case 'validate_time': {
        const { time } = task.params || {};
        const valid = this._validateTimeFormat(time);
        return { valid, time };
      }
      default:
        throw new Error('Unhandled action: ' + task.action);
    }
  }

  _validateTimeFormat(timeStr) {
    if (!timeStr) return false;
    // Accept: "HH:MM", "YYYY-MM-DD HH:MM", ISO 8601
    const patterns = [
      /^\d{1,2}:\d{2}$/,
      /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    ];
    return patterns.some(p => p.test(timeStr));
  }
}

// ── Search Agent ────────────────────────────────────────────────────────────

/**
 * Handles web search, internet lookup, and information retrieval.
 */
class SearchAgent extends Agent {
  constructor() {
    super({
      name: 'search',
      description: 'Performs web searches and retrieves information from the internet',
      capabilities: [
        'search:web',
        'search:weather',
        'search:news',
        'search:definition',
      ],
      timeoutMs: 15000,
    });
  }

  async execute(task) {
    const { action, params } = task;

    switch (action) {
      case 'web': {
        const { query } = params || {};
        if (!query) throw new Error('web search requires a query');
        const search = require('../tools/search');
        const results = await search.webSearch(query);
        return { results, query };
      }
      case 'weather': {
        const { location } = params || {};
        const weather = require('../tools/weather');
        const summary = await weather.getWeatherSummary(location);
        return { weather: summary };
      }
      case 'news': {
        const { topic } = params || {};
        const search = require('../tools/search');
        const news = await search.searchNews(topic || 'latest');
        return { news, topic };
      }
      case 'definition': {
        const { term } = params || {};
        if (!term) throw new Error('definition requires a term');
        const search = require('../tools/search');
        const def = await search.lookupDefinition(term);
        return { definition: def, term };
      }
      default:
        throw new Error('Unhandled action: ' + action);
    }
  }
}

// ── Weather Agent ───────────────────────────────────────────────────────────

class WeatherAgent extends Agent {
  constructor() {
    super({
      name: 'weather',
      description: 'Retrieves weather forecasts and summaries',
      capabilities: [
        'weather:current',
        'weather:forecast',
        'weather:summary',
      ],
    });
  }

  async execute(task) {
    const weather = require('../tools/weather');
    const { location } = task.params || {};

    switch (task.action) {
      case 'current':
        return { weather: await weather.getCurrentWeather(location) };
      case 'forecast':
        return { forecast: await weather.getForecast(location) };
      case 'summary':
        return { summary: await weather.getWeatherSummary(location) };
      default:
        throw new Error('Unhandled action: ' + task.action);
    }
  }
}

// ── Agent Registry ──────────────────────────────────────────────────────────

/**
 * Central registry that manages all agents. The executive (and plugins)
 * use this to discover and dispatch tasks to the right agent.
 */
class AgentRegistry {
  constructor() {
    /** @type {Map<string, Agent>} */
    this._agents = new Map();
    this._initialized = false;
  }

  /**
   * Register an agent instance.
   * @param {Agent} agent
   */
  register(agent) {
    if (this._agents.has(agent.name)) {
      throw new Error('Agent already registered: ' + agent.name);
    }
    this._agents.set(agent.name, agent);
    console.log('[AgentRegistry] Registered: ' + agent.name + ' — ' + agent.description);
  }

  /**
   * Initialize all registered agents.
   */
  async initAll() {
    if (this._initialized) return;
    const initOrder = this._resolveInitOrder();

    for (const name of initOrder) {
      const agent = this._agents.get(name);
      if (agent) {
        try {
          await agent.init();
        } catch (err) {
          console.error('[AgentRegistry] Failed to init ' + name + ':', err.message);
        }
      }
    }
    this._initialized = true;
    console.log('[AgentRegistry] All agents initialized (' + this._agents.size + ' total)');
  }

  /**
   * Dispatch a task to the appropriate agent based on the action namespace.
   *
   * @param {object} task - { userId, action: 'namespace:verb', params, context }
   * @returns {Promise<{success: boolean, result?: any, agent?: string, error?: string}>}
   */
  async dispatch(task) {
    const { action } = task;
    if (!action) return { success: false, error: 'No action specified' };

    // Extract namespace from action (e.g., 'memory:store_fact' → 'memory')
    const namespace = action.split(':')[0];

    // Find the agent that handles this namespace
    const agent = this._agents.get(namespace);

    if (!agent) {
      // Try capability matching
      for (const [name, a] of this._agents) {
        if (a.capabilities.includes(action)) {
          return this._runAgent(name, a, task);
        }
      }
      return { success: false, error: 'No agent found for action: ' + action };
    }

    return this._runAgent(namespace, agent, task);
  }

  /**
   * Get a specific agent by name.
   */
  get(name) {
    return this._agents.get(name) || null;
  }

  /**
   * Get all registered agents.
   */
  getAll() {
    return Array.from(this._agents.values());
  }

  /**
   * Get capabilities across all agents.
   */
  getAllCapabilities() {
    const caps = [];
    for (const agent of this._agents.values()) {
      caps.push(...agent.capabilities);
    }
    return caps;
  }

  /**
   * Find which agent can handle a given capability.
   */
  findAgentForCapability(capability) {
    for (const agent of this._agents.values()) {
      if (agent.capabilities.includes(capability)) {
        return agent.name;
      }
    }
    return null;
  }

  /**
   * Get status of all agents for monitoring/API.
   */
  getStatus() {
    return {
      initialized: this._initialized,
      totalAgents: this._agents.size,
      agents: Array.from(this._agents.values()).map(a => a.getStatus()),
    };
  }

  /**
   * Shutdown all agents gracefully.
   */
  async shutdown() {
    for (const agent of this._agents.values()) {
      try {
        await agent.cleanup();
      } catch (err) {
        console.warn('[AgentRegistry] Cleanup error for ' + agent.name + ':', err.message);
      }
    }
    this._agents.clear();
    this._initialized = false;
    console.log('[AgentRegistry] All agents shut down');
  }

  // ── Private ────────────────────────────────────────────────────────────

  async _runAgent(name, agent, task) {
    try {
      const result = await agent.runTask(task);
      return { ...result, agent: name };
    } catch (err) {
      return { success: false, agent: name, error: err.message };
    }
  }

  _resolveInitOrder() {
    // Simple topological sort based on 'requires' dependencies
    const visited = new Set();
    const order = [];
    const agents = this._agents; // capture reference for inner function

    const visit = (name) => {
      if (visited.has(name)) return;
      visited.add(name);
      const agent = agents.get(name);
      if (agent?.requires) {
        for (const dep of agent.requires) {
          if (agents.has(dep)) visit(dep);
        }
      }
      order.push(name);
    };

    for (const name of agents.keys()) {
      visit(name);
    }

    return order;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

const agentRegistry = new AgentRegistry();

// Register built-in agents
agentRegistry.register(new MemoryAgent());
agentRegistry.register(new TaskAgent());
agentRegistry.register(new ReminderAgent());
agentRegistry.register(new SearchAgent());
agentRegistry.register(new WeatherAgent());

module.exports = {
  Agent,
  AgentRegistry,
  agentRegistry,
  MemoryAgent,
  TaskAgent,
  ReminderAgent,
  SearchAgent,
  WeatherAgent,
};
