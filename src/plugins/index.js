// src/plugins/index.js
// ── Plugin System ────────────────────────────────────────────────────────────
//
// A lightweight plugin architecture that allows extending Jarvis with new
// capabilities without modifying core code. Plugins register hooks into
// the bot's lifecycle and can add commands, tools, scheduled tasks,
// message handlers, and custom agents.
//
// Plugin lifecycle:
//
//   discovered → loaded → initialized → enabled → [running] → disabled → unloaded
//
// Plugin manifest (plugin.json inside each plugin directory):
//
//   {
//     "name": "my-plugin",
//     "version": "1.0.0",
//     "description": "Does something cool",
//     "author": "Your Name",
//     "main": "index.js",              // entry point (relative to plugin dir)
//     "hooks": ["onMessage", "onCommand"],
//     "commands": ["/mycommand"],
//     "capabilities": ["custom:action"],
//     "dependencies": {},               // npm packages the plugin needs
//     "jarvisVersion": ">=2.0.0",
//     "config": {                       // default config (overridable via set_config)
//       "enabled": true,
//       "someOption": "default"
//     }
//   }
//
// Plugin hooks (all optional — implement only what you need):
//
//   onInit()           — called once when plugin is loaded
//   onEnable()         — called when plugin is enabled
//   onDisable()        — called when plugin is disabled
//   onUnload()         — called when plugin is removed
//   onMessage(ctx)     — called on every user message (can modify/reject)
//   onCommand(ctx)     — called when a registered command is invoked
//   onSchedule()       — called on the plugin's cron schedule
//   onEvent(event, payload) — called for every event bus event
//   onToolCall(tool)   — called before a tool is executed (can intercept)
//
// Plugin context (ctx) provided to hooks:
//   {
//     userId, message, bot,       // from the incoming message
//     llm,                        // LLM module (for plugin's own AI calls)
//     db,                         // database access
//     eventBus,                   // emit/listen to events
//     agentRegistry,              // register custom agents
//     tools,                      // access built-in tools
//     config,                     // plugin-specific configuration
//     logger,                     // namespaced logger
//   }

const path = require('path');
const fs = require('fs');
const { eventBus, EVENTS } = require('../events');
const { agentRegistry } = require('../agents');

// ── Plugin State ─────────────────────────────────────────────────────────────

const PLUGIN_STATES = Object.freeze({
  DISCOVERED: 'discovered',
  LOADED: 'loaded',
  INITIALIZED: 'initialized',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  ERROR: 'error',
  UNLOADED: 'unloaded',
});

// ── Plugin Context Factory ───────────────────────────────────────────────────

/**
 * Creates a rich context object passed to all plugin hooks.
 * Plugins use this to interact with Jarvis internals.
 */
function createPluginContext(pluginName, pluginConfig = {}) {
  const db = require('../db');
  const llm = require('../llm');

  return {
    // User, message, and bot are set per-invocation
    userId: null,
    message: null,
    bot: null,

    // Core modules (read-only access to internals)
    llm,
    db,
    eventBus,
    agentRegistry,
    tools: require('../tools'),
    memory: require('../memory'),
    patterns: require('../patterns'),

    // Plugin config (mutable, synced to DB)
    config: { ...pluginConfig },

    // Namespaced logger
    logger: {
      info: (...args) => console.log('[Plugin:' + pluginName + ']', ...args),
      warn: (...args) => console.warn('[Plugin:' + pluginName + ']', ...args),
      error: (...args) => console.error('[Plugin:' + pluginName + ']', ...args),
      debug: (...args) => console.debug('[Plugin:' + pluginName + ']', ...args),
    },

    // Register a custom command handler
    registerCommand: (command, handler) => {
      pluginRegistry._registerCommand(pluginName, command, handler);
    },

    // Register a cron schedule
    registerSchedule: (cronExpression, handler) => {
      pluginRegistry._registerSchedule(pluginName, cronExpression, handler);
    },

    // Register a custom agent
    registerAgent: (agent) => {
      pluginRegistry._registerPluginAgent(pluginName, agent);
    },
  };
}

// ── Plugin Instance ──────────────────────────────────────────────────────────

class Plugin {
  /**
   * @param {object} manifest - parsed plugin.json
   * @param {string} dirPath - absolute path to plugin directory
   */
  constructor(manifest, dirPath) {
    this.name = manifest.name;
    this.version = manifest.version;
    this.description = manifest.description || '';
    this.author = manifest.author || 'unknown';
    this.dirPath = dirPath;
    this.manifest = manifest;

    /** @type {string} */
    this.state = PLUGIN_STATES.DISCOVERED;

    /** @type {object|null} */
    this._module = null;         // the loaded plugin module

    /** @type {object|null} */
    this._ctx = null;            // plugin context

    /** @type {Function[]} */
    this._unsubscribers = [];    // event bus unsubscribe functions

    this._loadError = null;
    this._loadedAt = null;
    this._enabledAt = null;
  }

  /** Load the plugin module from disk. */
  async load() {
    try {
      const entryPoint = this.manifest.main || 'index.js';
      const modulePath = path.join(this.dirPath, entryPoint);

      if (!fs.existsSync(modulePath)) {
        throw new Error('Entry point not found: ' + modulePath);
      }

      // Clear require cache for hot-reload support
      delete require.cache[require.resolve(modulePath)];

      this._module = require(modulePath);
      this.state = PLUGIN_STATES.LOADED;
      this._loadedAt = new Date().toISOString();
      this._loadError = null;

      console.log('[Plugin:' + this.name + '] v' + this.version + ' loaded');
      return true;
    } catch (err) {
      this.state = PLUGIN_STATES.ERROR;
      this._loadError = err.message;
      console.error('[Plugin:' + this.name + '] Load failed:', err.message);
      return false;
    }
  }

  /** Initialize the plugin (calls onInit hook, registers commands/schedules). */
  async init() {
    if (this.state !== PLUGIN_STATES.LOADED) return false;

    try {
      this._ctx = createPluginContext(this.name, this.manifest.config || {});

      // Call onInit if defined
      if (typeof this._module.onInit === 'function') {
        await this._module.onInit(this._ctx);
      }

      // Register declared commands
      if (this.manifest.commands && Array.isArray(this.manifest.commands)) {
        for (const cmd of this.manifest.commands) {
          if (typeof this._module.onCommand === 'function') {
            this._ctx.registerCommand(cmd, this._module.onCommand.bind(this._module));
          }
        }
      }

      // Subscribe to events if onEvent hook exists
      if (typeof this._module.onEvent === 'function') {
        const unsub = eventBus.on('*', (payload, eventName) => {
          this._module.onEvent(eventName, payload, this._ctx);
        }, { priority: -50 }); // plugins run after core listeners
        this._unsubscribers.push(unsub);
      }

      this.state = PLUGIN_STATES.INITIALIZED;

      // If plugin config says enabled, auto-enable
      if (this.manifest.config?.enabled !== false) {
        await this.enable();
      }

      eventBus.emitSync(EVENTS.PLUGIN_LOADED, {
        name: this.name,
        version: this.version,
      });

      return true;
    } catch (err) {
      this.state = PLUGIN_STATES.ERROR;
      this._loadError = err.message;
      console.error('[Plugin:' + this.name + '] Init failed:', err.message);
      return false;
    }
  }

  /** Enable the plugin (calls onEnable, activates hooks). */
  async enable() {
    if (this.state === PLUGIN_STATES.ENABLED) return true;
    if (this.state === PLUGIN_STATES.ERROR) return false;

    try {
      if (typeof this._module.onEnable === 'function') {
        await this._module.onEnable(this._ctx);
      }

      this.state = PLUGIN_STATES.ENABLED;
      this._enabledAt = new Date().toISOString();
      console.log('[Plugin:' + this.name + '] ✅ Enabled');
      return true;
    } catch (err) {
      console.error('[Plugin:' + this.name + '] Enable failed:', err.message);
      return false;
    }
  }

  /** Disable the plugin (calls onDisable, deactivates hooks). */
  async disable() {
    if (this.state !== PLUGIN_STATES.ENABLED) return true;

    try {
      if (typeof this._module.onDisable === 'function') {
        await this._module.onDisable(this._ctx);
      }

      this.state = PLUGIN_STATES.DISABLED;
      console.log('[Plugin:' + this.name + '] 🔒 Disabled');
      return true;
    } catch (err) {
      console.error('[Plugin:' + this.name + '] Disable failed:', err.message);
      return false;
    }
  }

  /** Unload the plugin completely (calls onUnload, cleans up). */
  async unload() {
    try {
      // Disable first if enabled
      if (this.state === PLUGIN_STATES.ENABLED) {
        await this.disable();
      }

      // Call onUnload
      if (typeof this._module.onUnload === 'function') {
        await this._module.onUnload(this._ctx);
      }

      // Unsubscribe from all events
      for (const unsub of this._unsubscribers) {
        try { unsub(); } catch { /* ignore */ }
      }
      this._unsubscribers = [];

      // Remove from require cache
      const entryPoint = this.manifest.main || 'index.js';
      const modulePath = path.join(this.dirPath, entryPoint);
      delete require.cache[require.resolve(modulePath)];

      this._module = null;
      this._ctx = null;
      this.state = PLUGIN_STATES.UNLOADED;

      eventBus.emitSync(EVENTS.PLUGIN_UNLOADED, {
        name: this.name,
        version: this.version,
      });

      console.log('[Plugin:' + this.name + '] 🗑️ Unloaded');
      return true;
    } catch (err) {
      console.error('[Plugin:' + this.name + '] Unload failed:', err.message);
      return false;
    }
  }

  /** Execute the onMessage hook for this plugin. */
  async handleMessage(ctx) {
    if (this.state !== PLUGIN_STATES.ENABLED) return null;
    if (typeof this._module.onMessage !== 'function') return null;

    try {
      // Merge per-invocation context
      const fullCtx = { ...this._ctx, ...ctx };
      return await this._module.onMessage(fullCtx);
    } catch (err) {
      console.error('[Plugin:' + this.name + '] onMessage error:', err.message);
      return null;
    }
  }

  /** Execute the onToolCall hook for this plugin. */
  async handleToolCall(toolName, args, userId) {
    if (this.state !== PLUGIN_STATES.ENABLED) return null;
    if (typeof this._module.onToolCall !== 'function') return null;

    try {
      return await this._module.onToolCall(toolName, args, { ...this._ctx, userId });
    } catch (err) {
      console.error('[Plugin:' + this.name + '] onToolCall error:', err.message);
      return null;
    }
  }

  /** Get plugin status for monitoring. */
  getStatus() {
    return {
      name: this.name,
      version: this.version,
      description: this.description,
      author: this.author,
      state: this.state,
      hooks: this.manifest.hooks || [],
      commands: this.manifest.commands || [],
      loadedAt: this._loadedAt,
      enabledAt: this._enabledAt,
      error: this._loadError,
    };
  }
}

// ── Plugin Registry ──────────────────────────────────────────────────────────

class PluginRegistry {
  constructor() {
    /** @type {Map<string, Plugin>} */
    this._plugins = new Map();

    /** @type {Map<string, {plugin: string, handler: Function}>} */
    this._commands = new Map();

    /** @type {Map<string, {plugin: string, cronExpr: string, handler: Function}>} */
    this._schedules = new Map();

    /** @type {string[]} */
    this._pluginDirs = [
      path.join(process.cwd(), 'plugins'),          // project plugins
      path.join(process.cwd(), 'src', 'plugins', 'builtin'), // built-in plugins
    ];

    this._initialized = false;
  }

  /**
   * Add a directory to scan for plugins.
   */
  addPluginDir(dirPath) {
    if (!this._pluginDirs.includes(dirPath)) {
      this._pluginDirs.push(dirPath);
    }
  }

  /**
   * Discover all plugins from configured directories.
   * Scans for plugin.json files and creates Plugin instances.
   */
  async discover() {
    console.log('[PluginSystem] 🔍 Discovering plugins...');

    for (const dir of this._pluginDirs) {
      if (!fs.existsSync(dir)) {
        console.log('[PluginSystem] Directory not found, skipping: ' + dir);
        continue;
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(dir, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');

        if (!fs.existsSync(manifestPath)) continue;

        try {
          const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestRaw);

          // Validate required fields
          if (!manifest.name) {
            console.warn('[PluginSystem] Skipping plugin without name in: ' + pluginDir);
            continue;
          }
          if (!manifest.version) {
            console.warn('[PluginSystem] Skipping plugin without version: ' + manifest.name);
            continue;
          }

          // Check for duplicate
          if (this._plugins.has(manifest.name)) {
            console.warn('[PluginSystem] Duplicate plugin name, skipping: ' + manifest.name);
            continue;
          }

          const plugin = new Plugin(manifest, pluginDir);
          this._plugins.set(manifest.name, plugin);
          console.log('[PluginSystem] 📦 Discovered: ' + manifest.name + ' v' + manifest.version);

        } catch (err) {
          console.warn('[PluginSystem] Failed to parse manifest: ' + manifestPath, err.message);
        }
      }
    }

    console.log('[PluginSystem] Discovered ' + this._plugins.size + ' plugin(s)');
  }

  /**
   * Load and initialize all discovered plugins.
   */
  async initAll() {
    if (this._initialized) return;

    const results = { loaded: 0, failed: 0, errors: [] };

    for (const [name, plugin] of this._plugins) {
      const loaded = await plugin.load();
      if (!loaded) {
        results.failed++;
        results.errors.push({ name, error: plugin._loadError });
        continue;
      }

      const initialized = await plugin.init();
      if (initialized) {
        results.loaded++;
      } else {
        results.failed++;
        results.errors.push({ name, error: plugin._loadError });
      }
    }

    this._initialized = true;
    console.log('[PluginSystem] Initialized: ' + results.loaded + ' loaded, ' + results.failed + ' failed');

    return results;
  }

  /**
   * Run onMessage hooks across all enabled plugins.
   * Called by the bot for every incoming user message.
   *
   * @param {object} ctx - { userId, message, bot }
   * @returns {Promise<Array<{plugin: string, result: any}>>}
   */
  async runMessageHooks(ctx) {
    const results = [];

    for (const [name, plugin] of this._plugins) {
      if (plugin.state !== PLUGIN_STATES.ENABLED) continue;
      if (typeof plugin._module?.onMessage !== 'function') continue;

      const result = await plugin.handleMessage(ctx);
      if (result !== null && result !== undefined) {
        results.push({ plugin: name, result });
      }
    }

    return results;
  }

  /**
   * Handle a command that may belong to a plugin.
   *
   * @param {string} command - e.g., '/mycommand'
   * @param {object} ctx - { userId, message, bot, args }
   * @returns {Promise<{handled: boolean, result?: any}>}
   */
  async handleCommand(command, ctx) {
    const registration = this._commands.get(command);
    if (!registration) return { handled: false };

    const plugin = this._plugins.get(registration.plugin);
    if (!plugin || plugin.state !== PLUGIN_STATES.ENABLED) {
      return { handled: false };
    }

    try {
      const fullCtx = { ...plugin._ctx, ...ctx };
      const result = await registration.handler(fullCtx);
      return { handled: true, result };
    } catch (err) {
      console.error('[PluginSystem] Command handler error (' + command + '):', err.message);
      return { handled: true, result: { error: err.message } };
    }
  }

  /**
   * Run onToolCall hooks across all enabled plugins.
   * Plugins can intercept, modify, or reject tool calls.
   */
  async runToolCallHooks(toolName, args, userId) {
    for (const [name, plugin] of this._plugins) {
      if (plugin.state !== PLUGIN_STATES.ENABLED) continue;

      const result = await plugin.handleToolCall(toolName, args, userId);
      if (result !== null && result !== undefined) {
        // Plugin returned something — it intercepted the tool call
        return { intercepted: true, plugin: name, result };
      }
    }

    return { intercepted: false };
  }

  /**
   * Get a plugin by name.
   */
  get(name) {
    return this._plugins.get(name) || null;
  }

  /**
   * Get all plugins.
   */
  getAll() {
    return Array.from(this._plugins.values());
  }

  /**
   * Get all enabled plugins.
   */
  getEnabled() {
    return Array.from(this._plugins.values()).filter(p => p.state === PLUGIN_STATES.ENABLED);
  }

  /**
   * Enable a plugin by name.
   */
  async enable(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) return { success: false, error: 'Plugin not found: ' + name };
    return { success: await plugin.enable() };
  }

  /**
   * Disable a plugin by name.
   */
  async disable(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) return { success: false, error: 'Plugin not found: ' + name };
    return { success: await plugin.disable() };
  }

  /**
   * Unload a plugin by name.
   */
  async unload(name) {
    const plugin = this._plugins.get(name);
    if (!plugin) return { success: false, error: 'Plugin not found: ' + name };

    // Clean up commands
    for (const [cmd, reg] of this._commands) {
      if (reg.plugin === name) this._commands.delete(cmd);
    }

    // Clean up schedules
    for (const [key, reg] of this._schedules) {
      if (reg.plugin === name) this._schedules.delete(key);
    }

    const result = await plugin.unload();
    this._plugins.delete(name);
    return { success: result };
  }

  /**
   * Get full status of the plugin system.
   */
  getStatus() {
    return {
      initialized: this._initialized,
      totalPlugins: this._plugins.size,
      enabledPlugins: this.getEnabled().length,
      pluginDirs: this._pluginDirs,
      registeredCommands: Array.from(this._commands.keys()),
      plugins: Array.from(this._plugins.values()).map(p => p.getStatus()),
    };
  }

  /**
   * Shutdown all plugins.
   */
  async shutdown() {
    for (const [name, plugin] of this._plugins) {
      try {
        await plugin.unload();
      } catch (err) {
        console.warn('[PluginSystem] Shutdown error for ' + name + ':', err.message);
      }
    }
    this._plugins.clear();
    this._commands.clear();
    this._schedules.clear();
    this._initialized = false;
    console.log('[PluginSystem] All plugins shut down');
  }

  // ── Internal (called by plugin context) ────────────────────────────────

  _registerCommand(pluginName, command, handler) {
    if (this._commands.has(command)) {
      console.warn('[PluginSystem] Command already registered, overwriting: ' + command);
    }
    this._commands.set(command, { plugin: pluginName, handler });
    console.log('[PluginSystem] 📢 Command registered: ' + command + ' → ' + pluginName);
  }

  _registerSchedule(pluginName, cronExpression, handler) {
    const key = pluginName + '::' + cronExpression;
    this._schedules.set(key, { plugin: pluginName, cronExpr: cronExpression, handler });
    console.log('[PluginSystem] ⏰ Schedule registered: ' + cronExpression + ' → ' + pluginName);
  }

  _registerPluginAgent(pluginName, agent) {
    try {
      agentRegistry.register(agent);
      console.log('[PluginSystem] 🤖 Agent registered by ' + pluginName + ': ' + agent.name);
    } catch (err) {
      console.warn('[PluginSystem] Agent registration failed:', err.message);
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

const pluginRegistry = new PluginRegistry();

module.exports = { Plugin, PluginRegistry, pluginRegistry, PLUGIN_STATES };
