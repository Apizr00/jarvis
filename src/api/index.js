// src/api/index.js
// Optional REST API - useful for debugging and external integrations
const express = require('express');
const db = require('../db');
const { getHealthStatus, formatHealthMessage } = require('./health');
const { getApiStatus } = require('./status');

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);

function createApiServer() {
  const app = express();
  app.use(express.json());

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

  // ── GET / ───────────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    res.json({
      name: 'Jarvis - Personal AI Assistant',
      version: '3.0.0',
      environment: process.env.NODE_ENV || 'development',
      routes: [
        'GET  /',
        'GET  /health          — comprehensive system health (JSON)',
        'GET  /health/text     — system health (human-readable)',
        'GET  /status          — all API/component status',
        'GET  /today           — today\'s events & reminders',
        'POST /notes           — create a note',
        'GET  /memory          — full memory dump',
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
