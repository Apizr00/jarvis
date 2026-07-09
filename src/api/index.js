// src/api/index.js
// Optional REST API - useful for debugging and external integrations
const path = require('path');
const express = require('express');
const db = require('../db');
const { getHealthStatus, formatHealthMessage } = require('./health');
const { getApiStatus } = require('./status');
const prayerTimes = require('./prayertimes');
const { logger } = require('../utils/logger');

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);

function createApiServer() {
  const app = express();
  app.use(express.json());

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

  return app;
}

module.exports = { createApiServer };
