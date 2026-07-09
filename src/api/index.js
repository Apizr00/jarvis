// src/api/index.js
// Optional REST API - useful for debugging and external integrations
const path = require('path');
const express = require('express');
const db = require('../db');
const { getHealthStatus, formatHealthMessage } = require('./health');
const { getApiStatus } = require('./status');
const prayerTimes = require('./prayertimes');
const { logger } = require('../utils/logger');
const { requireAuth, telegramAuthHandler, tokenAuthHandler, meHandler } = require('./auth');
const pluginsApi = require('./plugins');
const tasksApi = require('./tasks');

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);

function createApiServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // ── Serve static files from public/ ─────────────────────────────────────
  app.use(express.static(path.join(__dirname, 'public')));

  // ── GET /today ─────────────────────────────────────────────────────────────
  app.get('/today', async (req, res) => {
    try {
      const [events, reminders] = await Promise.all([
        db.getTodayEvents(OWNER_ID),
        db.getTodayReminders(OWNER_ID),
      ]);
      res.json({
        date: new Date().toISOString().split('T')[0],
        events: events.map(e => ({ title: e.title, time: e.event_time, duration: e.duration_minutes })),
        reminders: reminders.map(r => ({ text: r.text, time: r.remind_at })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /notes ────────────────────────────────────────────────────────────
  app.post('/notes', async (req, res) => {
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: 'content is required' });
      const note = await db.addNote(OWNER_ID, content);
      res.json(note);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /memory ────────────────────────────────────────────────────────────
  app.get('/memory', async (req, res) => {
    try {
      const memory = await db.getFullMemory(OWNER_ID);
      res.json(memory);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /prayertimes ─────────────────────────────────────────────────────
  // Fetch prayer times from JAKIM e-Solat API with caching & safeguards
  app.get('/api/prayertimes', async (req, res) => {
    try {
      const zone = req.query.zone || prayerTimes.DEFAULT_ZONE;
      const forceRefresh = req.query.refresh === 'true';

      logger.info('Prayer times API requested', { zone, forceRefresh });

      const data = await prayerTimes.getPrayerTimes(zone, forceRefresh);

      // Set cache headers
      if (data._cached) {
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Age', String(data._cacheAge));
      } else {
        res.set('X-Cache', 'MISS');
      }
      if (data._stale) {
        res.set('X-Cache', 'STALE');
        res.set('X-Cache-Age', String(data._cacheAge));
      }

      res.json(data);
    } catch (err) {
      logger.error('Prayer times API error', { error: err.message });

      if (err.message.includes('Rate limit')) {
        return res.status(429).json({
          error: 'Rate limit exceeded. Please try again later.',
          retryAfter: 60,
        });
      }

      res.status(502).json({
        error: 'Failed to fetch prayer times from upstream provider.',
        detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    }
  });

  // ── GET /prayertimes/zones ───────────────────────────────────────────────
  // List available prayer time zones
  app.get('/api/prayertimes/zones', (req, res) => {
    res.json(prayerTimes.ZONES);
  });

  // ── GET /waktu-solat ─────────────────────────────────────────────────────
  // Redirect to the prayer times display page
  app.get('/waktu-solat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'prayertimes.html'));
  });

  // ── GET / ───────────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    res.json({
      name: 'Jarvis - Personal AI Assistant',
      version: '3.0.0',
      environment: process.env.NODE_ENV || 'development',
      routes: [
        'GET  /',
        'GET  /health              — comprehensive system health (JSON)',
        'GET  /health/text         — system health (human-readable)',
        'GET  /status              — all API/component status',
        'GET  /today               — today\'s events & reminders',
        'POST /notes               — create a note',
        'GET  /memory              — full memory dump',
        'GET  /api/prayertimes     — prayer times (JSON)',
        'GET  /api/prayertimes/zones — available zones',
        'GET  /waktu-solat         — prayer times display page',
      ],
    });
  });

  // ── GET /health ────────────────────────────────────────────────────────────
  // Comprehensive health check: DB, Redis, memory, error metrics
  app.get('/health', async (req, res) => {
    try {
      const health = await getHealthStatus();
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json(health);
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // ── GET /health/text ──────────────────────────────────────────────────────
  // Human-readable health status (for Telegram or terminal)
  app.get('/health/text', async (req, res) => {
    try {
      const health = await getHealthStatus();
      res.type('text/plain').send(formatHealthMessage(health));
    } catch (err) {
      res.status(500).type('text/plain').send('ERROR: ' + err.message);
    }
  });

  // ── GET /status ───────────────────────────────────────────────────────────
  // Full API status check (LLM providers, Telegram, Redis, etc.)
  app.get('/status', async (req, res) => {
    try {
      const statuses = await getApiStatus();
      res.json({
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        services: statuses.map(s => ({
          name: s.name,
          configured: s.configured,
          connected: s.connected,
          detail: s.detail,
        })),
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── AUTH ROUTES ───────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // POST /api/auth/telegram — verify Telegram Login Widget hash, issue JWT
  app.post('/api/auth/telegram', telegramAuthHandler);

  // POST /api/auth/token — simple token-based login (compare to TELEGRAM_BOT_TOKEN)
  app.post('/api/auth/token', tokenAuthHandler);

  // GET /api/auth/me — returns current user from JWT
  app.get('/api/auth/me', requireAuth, meHandler);

  // ═══════════════════════════════════════════════════════════════════════════
  // ── PLUGIN ROUTES (protected) ─────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/plugins/manifest — all enabled plugins with widget/page registrations
  app.get('/api/plugins/manifest', pluginsApi.getManifest);

  // GET /api/plugins — all plugins with status
  app.get('/api/plugins', requireAuth, pluginsApi.getAllPlugins);

  // POST /api/plugins/:name/toggle — enable/disable
  app.post('/api/plugins/:name/toggle', requireAuth, pluginsApi.togglePlugin);

  // GET /api/plugins/:name/config — get plugin config
  app.get('/api/plugins/:name/config', requireAuth, pluginsApi.getPluginConfig);

  // PUT /api/plugins/:name/config — update plugin config
  app.put('/api/plugins/:name/config', requireAuth, pluginsApi.updatePluginConfig);

  // POST /api/plugins/:name/reload — hot-reload
  app.post('/api/plugins/:name/reload', requireAuth, pluginsApi.reloadPlugin);

  // POST /api/plugins/upload — upload new plugin
  app.post('/api/plugins/upload', requireAuth, pluginsApi.uploadPlugin);

  // GET /api/widgets — all registered widgets
  app.get('/api/widgets', pluginsApi.getWidgets);

  // ═══════════════════════════════════════════════════════════════════════════
  // ── REMINDER ROUTES (protected) ───────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/reminders — list all reminders
  app.get('/api/reminders', requireAuth, async (req, res) => {
    try {
      const ownerId = req.user.sub;
      const reminders = await db.getUpcomingReminders(ownerId, 50);
      res.json({ reminders: reminders || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/reminders — create a reminder
  app.post('/api/reminders', requireAuth, async (req, res) => {
    try {
      const ownerId = req.user.sub;
      const { text, remindAt, recurrence } = req.body;
      if (!text || !remindAt) {
        return res.status(400).json({ error: 'text and remindAt are required' });
      }
      const reminder = await db.createReminder(ownerId, text, remindAt, recurrence || null);
      res.status(201).json({ reminder });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/reminders/:id — update a reminder
  app.put('/api/reminders/:id', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { text, remindAt, recurrence } = req.body;
      const updates = {};
      if (text !== undefined) updates.text = text;
      if (remindAt !== undefined) updates.remind_at = remindAt;
      if (recurrence !== undefined) updates.recurrence = recurrence;
      const reminder = await db.updateReminder(id, updates);
      if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
      res.json({ reminder });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/reminders/:id — cancel a reminder
  app.delete('/api/reminders/:id', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      await db.cancelReminder(id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── TASKS & NOTES ROUTES (protected) ──────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // Tasks
  app.get('/api/tasks', requireAuth, tasksApi.listTasks);
  app.post('/api/tasks', requireAuth, tasksApi.createTask);
  app.put('/api/tasks/:id', requireAuth, tasksApi.updateTask);
  app.delete('/api/tasks/:id', requireAuth, tasksApi.deleteTask);

  // Notes
  app.get('/api/notes', requireAuth, tasksApi.listNotes);
  app.post('/api/notes', requireAuth, tasksApi.createNote);
  app.put('/api/notes/:id', requireAuth, tasksApi.updateNote);
  app.delete('/api/notes/:id', requireAuth, tasksApi.deleteNote);

  // Goals
  app.get('/api/goals', requireAuth, tasksApi.listGoals);
  app.post('/api/goals', requireAuth, tasksApi.createGoal);
  app.put('/api/goals/:id', requireAuth, tasksApi.updateGoal);
  app.delete('/api/goals/:id', requireAuth, tasksApi.deleteGoal);

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MEMORY ROUTES (protected) ─────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/memory/facts — all memory facts (with optional ?search= filter)
  app.get('/api/memory/facts', requireAuth, async (req, res) => {
    try {
      const ownerId = req.user.sub;
      const { search } = req.query;
      let facts = await db.getAllFacts(ownerId);

      // Filter by search
      if (search && facts) {
        const q = search.toLowerCase();
        facts = facts.filter(f =>
          (f.key && f.key.toLowerCase().includes(q)) ||
          (f.value && String(f.value).toLowerCase().includes(q))
        );
      }

      res.json({ facts: facts || [], total: facts?.length || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/memory/facts/:key — update a memory fact (key is URL-encoded)
  app.put('/api/memory/facts/:key', requireAuth, async (req, res) => {
    try {
      const ownerId = req.user.sub;
      const key = decodeURIComponent(req.params.key);
      const { value } = req.body;

      if (value === undefined) {
        return res.status(400).json({ error: 'value is required' });
      }

      const updated = await db.setFact(ownerId, key, String(value));
      res.json({ fact: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/memory/facts/:key — delete a memory fact
  app.delete('/api/memory/facts/:key', requireAuth, async (req, res) => {
    try {
      const ownerId = req.user.sub;
      const key = decodeURIComponent(req.params.key);
      await db.deleteFact(ownerId, key);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── INSIGHTS PLUGIN DATA ENDPOINTS ────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  // These power the jarvis-insights plugin widgets on the playground dashboard.

  // GET /api/plugins/jarvis-insights/mood-data
  app.get('/api/plugins/jarvis-insights/mood-data', async (req, res) => {
    try {
      const ownerId = String(process.env.TELEGRAM_OWNER_ID);
      const facts = await db.getAllFacts(ownerId);
      const moodFact = facts.find(f => f.key === 'insights_mood_log');
      const moodLog = moodFact ? JSON.parse(moodFact.value || '[]') : [];
      res.json({ moods: moodLog.slice(-50), total: moodLog.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/plugins/jarvis-insights/weekly-data
  app.get('/api/plugins/jarvis-insights/weekly-data', async (req, res) => {
    try {
      const ownerId = String(process.env.TELEGRAM_OWNER_ID);
      const facts = await db.getAllFacts(ownerId);
      const countFact = facts.find(f => f.key === 'insights_message_count');
      const messageCount = countFact ? parseInt(countFact.value || '0', 10) : 0;
      res.json({
        messageCount,
        weekStart: new Date(Date.now() - 7 * 86400000).toISOString(),
        weekEnd: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/plugins/jarvis-insights/usage-data
  app.get('/api/plugins/jarvis-insights/usage-data', async (req, res) => {
    try {
      const ownerId = String(process.env.TELEGRAM_OWNER_ID);
      const facts = await db.getAllFacts(ownerId);
      const countFact = facts.find(f => f.key === 'insights_message_count');
      const moodFact = facts.find(f => f.key === 'insights_mood_log');
      res.json({
        totalMessages: countFact ? parseInt(countFact.value || '0', 10) : 0,
        totalMoods: moodFact ? JSON.parse(moodFact.value || '[]').length : 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── PLAYGROUND SPA — catch-all for React Router ───────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  // Serve the React SPA for any non-API, non-static route.
  // This must come LAST after all API routes and static middleware.
  const playgroundDir = path.join(__dirname, 'public', 'playground');
  const fs = require('fs');
  if (fs.existsSync(playgroundDir)) {
    // Serve playground static files (JS, CSS, assets)
    app.use('/assets', express.static(path.join(playgroundDir, 'assets')));

    // Serve index.html for all non-matched routes (SPA client-side routing)
    app.get('*', (req, res) => {
      // Skip API routes that weren't matched
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.sendFile(path.join(playgroundDir, 'index.html'));
    });
  }

  return app;
}

module.exports = { createApiServer };
