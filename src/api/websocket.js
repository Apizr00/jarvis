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

// ── Tool Buttons ─────────────────────────────────────────────────────────────
// Replicates Telegram bot's inline keyboard for each tool type.

function buildToolButtons(toolName, toolResult) {
  const id = toolResult?.id;
  const meta = toolResult?.meta || {};

  const buttons = [];

  switch (toolName) {
    case 'create_reminder':
    case 'update_reminder':
      buttons.push([
        { text: '✏️ Edit', action: `edit_reminder:${id}` },
        { text: '❌ Cancel', action: `cancel_reminder:${id}` },
      ]);
      buttons.push([{ text: '📋 View All Reminders', action: 'list_reminders' }]);
      break;

    case 'create_event':
    case 'update_event':
      buttons.push([
        { text: '✏️ Edit', action: `edit_event:${id}` },
        { text: '❌ Cancel', action: `cancel_event:${id}` },
      ]);
      buttons.push([{ text: '📅 View Today', action: 'get_today' }]);
      break;

    case 'add_note':
      buttons.push([{ text: '❌ Delete', action: `delete_note:${id}` }]);
      buttons.push([{ text: '📝 View All Notes', action: 'list_notes' }]);
      break;

    case 'create_task':
    case 'update_task':
      buttons.push([
        { text: '🚀 Start', action: `start_task:${id}` },
        { text: '✅ Done', action: `complete_task:${id}` },
      ]);
      buttons.push([
        { text: '❌ Cancel', action: `cancel_task:${id}` },
        { text: '📋 All Tasks', action: 'list_tasks' },
      ]);
      break;

    case 'create_goal':
      buttons.push([
        { text: '🏆 Complete', action: `complete_goal:${id}` },
        { text: '🗑️ Abandon', action: `abandon_goal:${id}` },
      ]);
      buttons.push([{ text: '🎯 All Goals', action: 'list_goals' }]);
      break;

    case 'set_fact':
      buttons.push([{ text: '❌ Forget', action: `forget_fact:${encodeURIComponent(meta.key || '')}` }]);
      break;

    case 'list_reminders':
      buttons.push([{ text: '➕ Set New Reminder', action: 'new_reminder' }]);
      break;

    case 'list_tasks':
      buttons.push([{ text: '➕ New Task', action: 'new_task' }, { text: '🎯 Goals', action: 'list_goals' }]);
      break;

    case 'list_goals':
      buttons.push([{ text: '➕ New Goal', action: 'new_goal' }, { text: '📋 Tasks', action: 'list_tasks' }]);
      break;

    case 'web_search':
      buttons.push([{ text: '📝 Save as Note', action: 'save_search_note' }]);
      break;
  }

  return buttons;
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
  if (activeStreams.has(convId)) {
    try { activeStreams.get(convId).abort(); } catch { /* ignore */ }
    activeStreams.delete(convId);
  }

  ws.send(JSON.stringify({ type: 'typing', payload: { active: true, conversationId: convId } }));

  let aborted = false;
  const abort = () => { aborted = true; };
  activeStreams.set(convId, { ws, abort });

  try {
    const llm = deps.llm || require('../llm');
    const tools = require('../tools');
    const { validateToolCall } = require('../tools');

    const providerMap = { ilmu: 'ilmu', deepseek: 'deepseek', mimo: 'mimo', auto: 'auto' };
    const provider = providerMap[requestedModel] || 'auto';

    // ── Call LLM ──────────────────────────────────────────────────────
    // Use 'deep' tier for potential tool usage (forces DeepSeek which is better at structured calls)
    const intent = require('../llm/intent').detectIntent(message);
    const tier = intent?.tier === 'deep' ? 'deep' : 'medium';

    let fullText = '';
    let result = await llm.chatStream(userId, message, [],
      { provider, tier },
      (chunk) => {
        if (aborted) throw new Error('ABORTED');
        fullText += chunk;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'chunk', payload: { text: chunk, conversationId: convId } }));
        }
      }
    );

    // ── Handle tool calls with retry ──────────────────────────────────
    if (result?.type === 'tool' && result?.name) {
      ws.send(JSON.stringify({ type: 'typing', payload: { active: false, conversationId: convId } }));

      // Validate tool args — retry once if args are incomplete
      let toolResult;
      let retryCount = 0;
      const MAX_RETRIES = 2;

      while (retryCount <= MAX_RETRIES) {
        const validation = validateToolCall(result.name, result.args);

        if (validation.valid) {
          // Execute valid tool call
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'tool_call',
              payload: { conversationId: convId, tool: result.name, args: result.args, message: `🔧 Running ${result.name.replace(/_/g, ' ')}...` },
            }));
          }

          toolResult = await tools.executeTool(userId, { name: result.name, args: result.args });
          break;
        }

        // Args invalid — ask LLM to fix
        retryCount++;
        logger.warn('Tool args invalid, retrying', { tool: result.name, error: validation.error, retry: retryCount });

        if (retryCount > MAX_RETRIES) {
          toolResult = `❌ Cannot ${result.name.replace(/_/g, ' ')} — ${validation.error}`;
          break;
        }

        // Re-prompt LLM to fix the args
        const retryMsg = `You tried to call ${result.name} with args ${JSON.stringify(result.args)} but it failed because: ${validation.error}. Please fix and return the corrected tool call.`;
        fullText = '';
        result = await llm.chatStream(userId, retryMsg, [],
          { provider: 'deepseek', tier: 'deep' },
          (chunk) => {
            if (aborted) throw new Error('ABORTED');
            fullText += chunk;
          }
        );

        if (result?.type !== 'tool') {
          toolResult = result?.content || `❌ Failed to fix tool call.`;
          break;
        }
      }

      // Send tool result with action buttons (matching Telegram inline keyboards)
      const toolMessage = typeof toolResult === 'string' ? toolResult : (toolResult?.message || '✅ Done.');
      const buttons = buildToolButtons(result.name, toolResult);

      if (!aborted && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'tool_result',
          payload: {
            conversationId: convId, tool: result.name, content: toolMessage,
            error: toolMessage.startsWith('❌'), buttons,
            timestamp: new Date().toISOString(),
          },
        }));
      }

      // Follow-up explanation from LLM
      ws.send(JSON.stringify({ type: 'typing', payload: { active: true, conversationId: convId } }));
      let followupText = '';
      const followupResult = await llm.chatStream(userId,
        `You just executed: ${result.name}. Result: ${toolMessage.slice(0, 500)}. Confirm briefly in a friendly tone. 1-2 sentences max.`,
        [], { provider: 'ilmu', tier: 'fast' },
        (chunk) => { if (aborted) throw new Error('ABORTED'); followupText += chunk; if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'chunk', payload: { text: chunk, conversationId: convId } })); }
      );
      if (!followupText && followupResult?.content) followupText = followupResult.content;

      ws.send(JSON.stringify({ type: 'typing', payload: { active: false, conversationId: convId } }));
      if (!aborted && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'done', payload: { conversationId: convId, fullText: followupText || '✅ Done!', metadata: { model: requestedModel || 'auto', provider: 'ilmu', timestamp: new Date().toISOString() } } }));
      }
      return;
    }

    // ── Regular message ───────────────────────────────────────────────
    if (!fullText && result?.content) fullText = result.content;
    ws.send(JSON.stringify({ type: 'typing', payload: { active: false, conversationId: convId } }));
    if (!aborted && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'done', payload: { conversationId: convId, fullText, metadata: { model: requestedModel || 'auto', provider: result?._provider || provider, timestamp: new Date().toISOString() } } }));
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
