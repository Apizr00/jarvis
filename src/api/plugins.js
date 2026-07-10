// src/api/plugins.js
// ── Plugin Management API ────────────────────────────────────────────────────
//
// Endpoints for the Plugin Manager frontend:
//   GET    /api/plugins/manifest  — all enabled plugins with widget/page registrations
//   GET    /api/plugins           — all plugins (with status)
//   POST   /api/plugins/:name/toggle — enable/disable a plugin
//   GET    /api/plugins/:name/config  — get plugin config
//   PUT    /api/plugins/:name/config  — update plugin config
//   POST   /api/plugins/:name/reload  — hot-reload a plugin
//   POST   /api/plugins/upload        — upload a new plugin (zip/folder)
//   GET    /api/widgets               — all registered widgets (for frontend widget registry)

const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the plugin registry instance. Lazy-loaded to avoid circular deps.
 */
function getPluginRegistry() {
  return require('../plugins').pluginRegistry;
}

/**
 * Get the database instance.
 */
function getDb() {
  return require('../db');
}

// ── Widget & Page Registry ───────────────────────────────────────────────────

/**
 * In-memory registry of all widgets and pages registered by plugins.
 * Each entry: { pluginName, widgetId, title, icon, type, defaultSize, refreshInterval, config }
 */
const widgetRegistry = [];
const pageRegistry = [];

/**
 * Register a widget from a plugin.
 * Called by plugins during onInit via ctx.registerWidget().
 */
function registerWidget(pluginName, widget) {
  const entry = {
    pluginName,
    widgetId: widget.id || `${pluginName}:${widget.title}`,
    title: widget.title || widget.id,
    icon: widget.icon || '📦',
    type: widget.type || 'card', // card | list | chart | iframe | custom
    description: widget.description || '',
    defaultSize: widget.defaultSize || { w: 2, h: 1 }, // 4-col grid
    minSize: widget.minSize || { w: 1, h: 1 },
    maxSize: widget.maxSize || { w: 4, h: 3 },
    refreshInterval: widget.refreshInterval || 0, // ms, 0 = no auto-refresh
    endpoint: widget.endpoint || null, // API endpoint for widget data
    permissions: widget.permissions || [],
    config: widget.config || {},
    registeredAt: new Date().toISOString(),
  };

  // Remove existing widget with same ID from same plugin (re-registration)
  const idx = widgetRegistry.findIndex(w => w.widgetId === entry.widgetId && w.pluginName === pluginName);
  if (idx >= 0) widgetRegistry.splice(idx, 1);

  widgetRegistry.push(entry);
  logger.info(`Widget registered: ${entry.widgetId} (plugin: ${pluginName})`);
  return entry;
}

/**
 * Register a page from a plugin.
 */
function registerPage(pluginName, page) {
  const entry = {
    pluginName,
    path: page.path || `/${pluginName}/${page.title?.toLowerCase().replace(/\s+/g, '-')}`,
    title: page.title || pluginName,
    icon: page.icon || '📄',
    component: page.component || 'generic-page',
    layout: page.layout || 'default', // default | fullscreen | sidebar
    permissions: page.permissions || [],
    config: page.config || {},
    registeredAt: new Date().toISOString(),
  };

  const idx = pageRegistry.findIndex(p => p.path === entry.path);
  if (idx >= 0) pageRegistry.splice(idx, 1);

  pageRegistry.push(entry);
  logger.info(`Page registered: ${entry.path} (plugin: ${pluginName})`);
  return entry;
}

/**
 * Unregister all widgets and pages from a plugin.
 */
function unregisterPluginWidgets(pluginName) {
  const widgetCount = widgetRegistry.filter(w => w.pluginName === pluginName).length;
  const pageCount = pageRegistry.filter(p => p.pluginName === pluginName).length;

  for (let i = widgetRegistry.length - 1; i >= 0; i--) {
    if (widgetRegistry[i].pluginName === pluginName) widgetRegistry.splice(i, 1);
  }
  for (let i = pageRegistry.length - 1; i >= 0; i--) {
    if (pageRegistry[i].pluginName === pluginName) pageRegistry.splice(i, 1);
  }

  if (widgetCount > 0 || pageCount > 0) {
    logger.info(`Unregistered ${widgetCount} widgets, ${pageCount} pages from plugin: ${pluginName}`);
  }
}

// ── Plugin Context Extensions ────────────────────────────────────────────────

/**
 * Enhance the plugin context with widget/page registration methods.
 * Called by PluginRegistry when creating plugin context.
 */
function enhancePluginContext(ctx, pluginName) {
  ctx.registerWidget = (widget) => registerWidget(pluginName, widget);
  ctx.registerPage = (page) => registerPage(pluginName, page);
  ctx.unregisterAll = () => unregisterPluginWidgets(pluginName);
  return ctx;
}

// ── API Route Handlers ───────────────────────────────────────────────────────

/**
 * GET /api/plugins/manifest
 * Returns all enabled plugins with their widget and page registrations.
 * This is the primary endpoint for the frontend widget registry.
 */
function getManifest(req, res) {
  try {
    const registry = getPluginRegistry();
    const plugins = [];

    for (const [name, plugin] of registry._plugins) {
      if (plugin.state === 'enabled') {
        const status = plugin.getStatus();
        const pluginWidgets = widgetRegistry.filter(w => w.pluginName === name);
        const pluginPages = pageRegistry.filter(p => p.pluginName === name);

        plugins.push({
          name: status.name,
          version: status.version,
          description: status.description,
          author: status.author,
          commands: status.commands,
          widgets: pluginWidgets.map(w => ({
            widgetId: w.widgetId,
            title: w.title,
            icon: w.icon,
            type: w.type,
            description: w.description,
            defaultSize: w.defaultSize,
            refreshInterval: w.refreshInterval,
            endpoint: w.endpoint,
            config: w.config,
          })),
          pages: pluginPages.map(p => ({
            path: p.path,
            title: p.title,
            icon: p.icon,
            layout: p.layout,
          })),
        });
      }
    }

    res.json({
      plugins,
      totalWidgets: widgetRegistry.length,
      totalPages: pageRegistry.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Plugin manifest error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/plugins
 * Returns all plugins with full status.
 */
function getAllPlugins(req, res) {
  try {
    const registry = getPluginRegistry();
    const plugins = [];

    for (const [name, plugin] of registry._plugins) {
      const status = plugin.getStatus();
      const pluginWidgets = widgetRegistry.filter(w => w.pluginName === name);
      const pluginPages = pageRegistry.filter(p => p.pluginName === name);

      plugins.push({
        ...status,
        widgetCount: pluginWidgets.length,
        pageCount: pluginPages.length,
        widgets: pluginWidgets.map(w => w.widgetId),
        pages: pluginPages.map(p => p.path),
      });
    }

    res.json({ plugins, total: plugins.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/plugins/:name/toggle
 * Body: { enabled: true|false }
 */
async function togglePlugin(req, res) {
  try {
    const { name } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must include { enabled: true|false }' });
    }

    const registry = getPluginRegistry();
    const plugin = registry._plugins.get(name);

    if (!plugin) {
      return res.status(404).json({ error: `Plugin not found: ${name}` });
    }

    let success;
    if (enabled) {
      success = await plugin.enable();
    } else {
      success = await plugin.disable();
    }

    // Persist config to DB
    try {
      const db = getDb();
      const ownerId = String(process.env.TELEGRAM_OWNER_ID);
      await db.setPluginConfig(ownerId, name, { enabled });
    } catch (dbErr) {
      logger.warn('Failed to persist plugin toggle to DB', { plugin: name, error: dbErr.message });
    }

    res.json({
      name: plugin.name,
      state: plugin.state,
      success,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/plugins/:name/config
 */
function getPluginConfig(req, res) {
  try {
    const { name } = req.params;
    const registry = getPluginRegistry();
    const plugin = registry._plugins.get(name);

    if (!plugin) {
      return res.status(404).json({ error: `Plugin not found: ${name}` });
    }

    res.json({
      name: plugin.name,
      config: plugin._ctx?.config || plugin.manifest.config || {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * PUT /api/plugins/:name/config
 * Body: { key: value, ... }
 */
async function updatePluginConfig(req, res) {
  try {
    const { name } = req.params;
    const newConfig = req.body;

    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object of config key/values' });
    }

    const registry = getPluginRegistry();
    const plugin = registry._plugins.get(name);

    if (!plugin) {
      return res.status(404).json({ error: `Plugin not found: ${name}` });
    }

    // Merge config
    if (plugin._ctx) {
      Object.assign(plugin._ctx.config, newConfig);
    }

    // Persist to DB
    try {
      const db = getDb();
      const ownerId = String(process.env.TELEGRAM_OWNER_ID);
      await db.setPluginConfig(ownerId, name, plugin._ctx?.config || newConfig);
    } catch (dbErr) {
      logger.warn('Failed to persist plugin config to DB', { plugin: name, error: dbErr.message });
    }

    res.json({
      name: plugin.name,
      config: plugin._ctx?.config || newConfig,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/plugins/:name/reload
 * Hot-reloads a single plugin without server restart.
 */
async function reloadPlugin(req, res) {
  try {
    const { name } = req.params;
    const registry = getPluginRegistry();
    const plugin = registry._plugins.get(name);

    if (!plugin) {
      return res.status(404).json({ error: `Plugin not found: ${name}` });
    }

    // Unload then reload
    await plugin.unload();
    unregisterPluginWidgets(name);

    const loaded = await plugin.load();
    if (!loaded) {
      return res.status(500).json({ error: 'Failed to reload plugin', detail: plugin._loadError });
    }

    // Re-init
    await plugin.init();

    // Re-enable if was enabled
    const wasEnabled = plugin.state === 'enabled' || plugin.manifest.config?.enabled !== false;
    if (wasEnabled) {
      await plugin.enable();
    }

    res.json({
      name: plugin.name,
      state: plugin.state,
      success: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/plugins/upload
 * Upload a new plugin. Accepts multipart form with a .zip file or folder path.
 *
 * For now, this supports uploading a plugin folder from a local path on the server.
 * Full .zip upload with extraction will be added when multer is available.
 */
async function uploadPlugin(req, res) {
  try {
    // For now, accept a { dirPath } to copy a local plugin
    const { dirPath: sourcePath, pluginName } = req.body;

    if (!sourcePath || !pluginName) {
      return res.status(400).json({
        error: 'Body must include { dirPath, pluginName }. Full .zip upload coming soon.',
        hint: 'Place your plugin folder on the server and provide the path.',
      });
    }

    const builtinDir = path.join(process.cwd(), 'src', 'plugins', 'builtin');
    const targetDir = path.join(builtinDir, pluginName);

    if (fs.existsSync(targetDir)) {
      return res.status(409).json({ error: `Plugin directory already exists: ${targetDir}` });
    }

    // Copy directory recursively
    fs.cpSync(sourcePath, targetDir, { recursive: true });

    // Discover and load the new plugin
    const registry = getPluginRegistry();
    await registry.discover();

    // Find and init the new plugin
    const newPlugin = registry._plugins.get(pluginName);
    if (!newPlugin) {
      return res.status(500).json({ error: 'Plugin was copied but could not be discovered. Check plugin.json.' });
    }

    await newPlugin.load();
    await newPlugin.init();

    res.json({
      name: newPlugin.name,
      state: newPlugin.state,
      message: 'Plugin uploaded and loaded successfully',
    });
  } catch (err) {
    logger.error('Plugin upload failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/widgets
 * Returns all registered widgets across all enabled plugins.
 * Simplified endpoint for the frontend widget grid.
 */
function getWidgets(req, res) {
  try {
    const registry = getPluginRegistry();
    const enabledPlugins = new Set();

    for (const [name, plugin] of registry._plugins) {
      if (plugin.state === 'enabled') enabledPlugins.add(name);
    }

    const widgets = widgetRegistry
      .filter(w => enabledPlugins.has(w.pluginName))
      .map(w => ({
        widgetId: w.widgetId,
        pluginName: w.pluginName,
        title: w.title,
        icon: w.icon,
        type: w.type,
        description: w.description,
        defaultSize: w.defaultSize,
        refreshInterval: w.refreshInterval,
        endpoint: w.endpoint,
        config: w.config,
      }));

    res.json({ widgets, total: widgets.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Registry functions (used by plugin system)
  registerWidget,
  registerPage,
  unregisterPluginWidgets,
  enhancePluginContext,
  widgetRegistry,
  pageRegistry,

  // Route handlers (used by API server)
  getManifest,
  getAllPlugins,
  togglePlugin,
  getPluginConfig,
  updatePluginConfig,
  reloadPlugin,
  uploadPlugin,
  getWidgets,
};
