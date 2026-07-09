// src/api/websocket.js
// ── WebSocket Server for Real-Time Chat ──────────────────────────────────────
//
// Provides:
//   - Bidirectional streaming chat (reuses existing LLM pipeline)
//   - Typing indicators
//   - Chat cancellation
//   - System event broadcasts
//
// Protocol (JSON messages):
//   Client → Server:
//     { type: "chat", payload: { message, model?, conversationId? } }
//     { type: "cancel", payload: { conversationId? } }
//     { type: "ping" }
//
//   Server → Client:
//     { type: "chunk", payload: { text, conversationId } }
//     { type: "done", payload: { conversationId, fullText, metadata } }
//     { type: "error", payload: { message, code } }
//     { type: "typing", payload: { active: true|false } }
//     { type: "pong" }
//     { type: "event", payload: { eventName, data } }

const WebSocket = require('ws');
const { authenticateWebSocket } = require('./auth');
const { logger } = require('../utils/logger');

// ── Constants ────────────────────────────────────────────────────────────────
const PING_INTERVAL = 30000; // 30s
const MAX_MESSAGE_LENGTH = 4000;

// ── WebSocket Server ─────────────────────────────────────────────────────────

/**
 * Create and attach a WebSocket server to an existing HTTP server.
 *
 * @param {import('http').Server} httpServer
 * @param {object} deps — injected dependencies
 * @param {object} deps.llm — LLM module
 * @param {object} deps.eventBus — event bus
 * @returns {WebSocket.Server}
 */
function createWebSocketServer(httpServer, deps = {}) {
  const wss = new WebSocket.Server({
    server: httpServer,
    path: '/ws',
    maxPayload: 64 * 1024, // 64KB
  });

  // Track active conversations for cancellation
  const activeStreams = new Map(); // conversationId → { abort: Function }

  logger.info('WebSocket server created on path /ws');

  wss.on('connection', (ws, req) => {
    // ── Auth ───────────────────────────────────────────────────────────
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { user, error: authError } = authenticateWebSocket(url);

    if (authError) {
      logger.warn('WebSocket auth failed', { error: authError, ip: req.socket.remoteAddress });
      ws.send(JSON.stringify({ type: 'error', payload: { message: authError, code: 401 } }));
      ws.close(4001, authError);
      return;
    }

    const userId = user.sub;
    logger.info('WebSocket connected', { userId });

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      payload: { userId, message: 'Connected to Jarvis WebSocket' },
    }));

    // ── Ping/Pong for keep-alive ───────────────────────────────────────
    let isAlive = true;
    const pingTimer = setInterval(() => {
      if (!isAlive) {
        logger.debug('WebSocket ping timeout, terminating', { userId });
        ws.terminate();
        return;
      }
      isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }, PING_INTERVAL);

    ws.on('pong', () => { isAlive = true; });

    // ── Message Handler ────────────────────────────────────────────────
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON', code: 400 } }));
        return;
      }

      const { type, payload = {} } = msg;

      switch (type) {
        case 'chat':
          await handleChatMessage(ws, userId, payload, activeStreams, deps);
          break;

        case 'cancel':
          handleCancel(payload, activeStreams);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Unknown message type: ${type}`, code: 400 } }));
      }
    });

    // ── Close Handler ──────────────────────────────────────────────────
    ws.on('close', (code, reason) => {
      clearInterval(pingTimer);
      // Cancel any active streams for this connection
      for (const [convId, stream] of activeStreams) {
        if (stream.ws === ws) {
          try { stream.abort(); } catch { /* ignore */ }
          activeStreams.delete(convId);
        }
      }
      logger.info('WebSocket disconnected', { userId, code, reason: reason?.toString() });
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', { userId, error: err.message });
    });
  });

  // ── Event Bus Bridge ─────────────────────────────────────────────────────
  // Broadcast system events to all connected clients
  if (deps.eventBus) {
    deps.eventBus.on('*', (payload, eventName) => {
      const broadcast = JSON.stringify({
        type: 'event',
        payload: { eventName, data: payload },
      });
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(broadcast); } catch { /* ignore */ }
        }
      });
    }, { priority: -100 }); // low priority — fire after core handlers
  }

  return wss;
}

// ── Chat Handler ─────────────────────────────────────────────────────────────

async function handleChatMessage(ws, userId, payload, activeStreams, deps) {
  const { message, model: requestedModel, conversationId } = payload;

  // Validate
  if (!message || typeof message !== 'string') {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'Missing or invalid "message" field', code: 400 } }));
    return;
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)`, code: 400 } }));
    return;
  }

  const convId = conversationId || `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Cancel any previous stream for this conversation
  if (activeStreams.has(convId)) {
    try { activeStreams.get(convId).abort(); } catch { /* ignore */ }
    activeStreams.delete(convId);
  }

  // ── Typing indicator ─────────────────────────────────────────────────
  ws.send(JSON.stringify({ type: 'typing', payload: { active: true, conversationId: convId } }));

  // ── Abort controller ─────────────────────────────────────────────────
  let aborted = false;
  const abort = () => { aborted = true; };
  activeStreams.set(convId, { ws, abort });

  try {
    const llm = deps.llm || require('../llm');

    // Build context
    const { buildSystemPrompt } = require('../llm/shared');
    const systemPrompt = await buildSystemPrompt(userId);

    // Stream response
    let fullText = '';
    await llm.chatStream(
      userId,
      message,
      [],                              // conversationHistory (empty for new chat)
      {
        systemPrompt,
        model: requestedModel || 'auto',
      },
      (chunk) => {                     // onChunk callback (5th argument)
        if (aborted) throw new Error('ABORTED');
        fullText += chunk;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'chunk',
            payload: { text: chunk, conversationId: convId },
          }));
        }
      }
    );

    // ── Done ───────────────────────────────────────────────────────────
    ws.send(JSON.stringify({
      type: 'typing',
      payload: { active: false, conversationId: convId },
    }));

    if (!aborted && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'done',
        payload: {
          conversationId: convId,
          fullText,
          metadata: {
            model: requestedModel || 'auto',
            timestamp: new Date().toISOString(),
          },
        },
      }));
    }
  } catch (err) {
    if (err.message === 'ABORTED') {
      logger.debug('Chat stream aborted', { userId, convId });
      return;
    }

    logger.error('WebSocket chat error', { userId, convId, error: err.message });

    ws.send(JSON.stringify({
      type: 'typing',
      payload: { active: false, conversationId: convId },
    }));

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: {
          message: err.message || 'Chat generation failed',
          code: 500,
          conversationId: convId,
        },
      }));
    }
  } finally {
    activeStreams.delete(convId);
  }
}

// ── Cancel Handler ───────────────────────────────────────────────────────────

function handleCancel(payload, activeStreams) {
  const { conversationId } = payload;
  if (conversationId && activeStreams.has(conversationId)) {
    try { activeStreams.get(conversationId).abort(); } catch { /* ignore */ }
    activeStreams.delete(conversationId);
    logger.debug('Chat cancelled', { conversationId });
  }
}

module.exports = { createWebSocketServer };
