// src/api/index.js
// Optional REST API - useful for debugging and external integrations
const express = require('express');
const db = require('../db');

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
      version: '1.0.0',
      routes: ['GET /', 'GET /today', 'POST /notes', 'GET /memory', 'GET /health'],
    });
  });

  // ── GET /health ────────────────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  return app;
}

module.exports = { createApiServer };
