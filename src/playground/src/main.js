/* ═══════════════════════════════════════════════════════════════════════
   Jarvis Playground — Vanilla JS SPA (No React)
   Hash-based router, shared state, WebSocket chat, PWA-ready
   ═══════════════════════════════════════════════════════════════════════ */

// ── DOM refs ────────────────────────────────────────────────────────────
const $ = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

// ── State ───────────────────────────────────────────────────────────────
// Bump this version when the UI structure changes — invalidates all caches
const APP_VERSION = 'v2.4';

const state = {
  user: null,
  token: localStorage.getItem('jarvis_token') || null,
  isAuthenticated: !!localStorage.getItem('jarvis_token'),

  messages: [],
  streaming: false,
  streamingText: '',
  model: localStorage.getItem('jarvis_chat_model') || 'auto',
  wsConnected: false,
  wsRef: null,
  reconnectTimer: null,

  themePref: localStorage.getItem('jarvis-theme') || 'system',
  themeResolved: 'dark',

  widgets: [],
  widgetLayout: [],
  widgetLoading: false,
  widgetError: null,

  ownerPhoto: null,  // Telegram profile photo URL
  botPhoto: null,     // Bot profile photo URL
};

// Load persisted data — auto-invalidates if app version changed
(function loadPersisted() {
  const storedVer = localStorage.getItem('jarvis-app-version');
  if (storedVer !== APP_VERSION) {
    // Version mismatch — clear all UI caches (keep auth token)
    const keepToken = localStorage.getItem('jarvis_token');
    const keepTheme = localStorage.getItem('jarvis-theme');
    const keepZone = localStorage.getItem('prayerZone');
    localStorage.clear();
    if (keepToken) localStorage.setItem('jarvis_token', keepToken);
    if (keepTheme) localStorage.setItem('jarvis-theme', keepTheme);
    if (keepZone) localStorage.setItem('prayerZone', keepZone);
    localStorage.setItem('jarvis-app-version', APP_VERSION);
  }
  try {
    const saved = localStorage.getItem('jarvis_chat_messages');
    if (saved) state.messages = JSON.parse(saved);
  } catch { }
  try {
    const layout = localStorage.getItem('jarvis-widget-layout');
    if (layout) state.widgetLayout = JSON.parse(layout);
  } catch { }
  try {
    const cached = localStorage.getItem('jarvis-widgets-cache');
    if (cached) state.widgets = JSON.parse(cached);
  } catch { }
})();

function persistMessages() {
  try { localStorage.setItem('jarvis_chat_messages', JSON.stringify(state.messages.slice(-100))); } catch { }
}
function persistLayout() {
  try { localStorage.setItem('jarvis-widget-layout', JSON.stringify(state.widgetLayout)); } catch { }
}
function persistWidgetCache() {
  try {
    localStorage.setItem('jarvis-widgets-cache', JSON.stringify(state.widgets));
    localStorage.setItem('jarvis-app-version', APP_VERSION);
  } catch { }
}
function persistLastRoute(route) {
  try { localStorage.setItem('jarvis-last-route', route); } catch { }
}

// ── Router ──────────────────────────────────────────────────────────────
const PAGE_TITLES = {
  '/': 'Dashboard', '/chat': 'AI Chat', '/tasks': 'Tasks',
  '/notes': 'Notes', '/memory': 'Memory Browser', '/plugins': 'Plugin Manager',
  '/settings': 'Settings', '/waktu-solat': 'Waktu Solat', '/reminders': 'Reminders',
};

const NAV_ITEMS = [
  { to: '/', icon: '🏠', label: 'Dashboard' },
  { to: '/chat', icon: '💬', label: 'Chat' },
  { to: '/tasks', icon: '✅', label: 'Tasks' },
  { to: '/reminders', icon: '⏰', label: 'Reminders' },
  { to: '/notes', icon: '📝', label: 'Notes' },
  { to: '/waktu-solat', icon: '🕌', label: 'Waktu Solat' },
  { to: '/memory', icon: '🧠', label: 'Memory' },
  { to: '/plugins', icon: '🔌', label: 'Plugins' },
  { to: '/settings', icon: '⚙️', label: 'Settings' },
];

const MOBILE_NAV = [
  { to: '/', icon: '🏠', label: 'Home' },
  { to: '/chat', icon: '💬', label: 'Chat' },
  { to: '/tasks', icon: '✅', label: 'Tasks' },
  { to: '/reminders', icon: '⏰', label: 'Remind' },
  { to: '/waktu-solat', icon: '🕌', label: 'Solat' },
];

let currentRoute = '';

function getRoute() {
  return location.hash.slice(1) || '/';
}

function navigate(to) {
  persistLastRoute(to);
  location.hash = to;
}

function renderRoute() {
  const route = getRoute();
  if (route === currentRoute) return;
  currentRoute = route;

  if (!state.isAuthenticated && route !== '/login') {
    location.hash = '#/login';
    return;
  }
  if (state.isAuthenticated && route === '/login') {
    location.hash = '#/';
    return;
  }

  // Show correct page
  if (route === '/login') {
    $('#page-app').classList.add('hidden');
    $('#page-login').classList.remove('hidden');
    return;
  }

  $('#page-login').classList.add('hidden');
  $('#page-app').classList.remove('hidden');

  // Update title
  $('#page-title').textContent = PAGE_TITLES[route] || 'Jarvis Playground';

  // Update nav active states
  $$('.nav-item, .mobile-nav-item').forEach(el => el.classList.remove('active'));
  const navLink = $(`.nav-item[data-to="${route}"]`) || $(`.mobile-nav-item[data-to="${route}"]`);
  if (navLink) navLink.classList.add('active');

  // Render page
  const container = $('#main-content');
  container.innerHTML = '';
  container.classList.add('fade-in');
  setTimeout(() => container.classList.remove('fade-in'), 300);

  // Hide right chat panel when on full chat page (same content, no duplicate)
  const panel = $('#chat-panel');
  if (route === '/chat') {
    if (panel) panel.classList.add('hidden');
  } else {
    if (panel) panel.classList.remove('hidden');
  }

  switch (route) {
    case '/': renderDashboard(container); break;
    case '/chat': renderChatPage(container); break;
    case '/tasks': renderTasksPage(container); break;
    case '/notes': renderNotesPage(container); break;
    case '/memory': renderMemoryPage(container); break;
    case '/plugins': renderPluginsPage(container); break;
    case '/settings': renderSettingsPage(container); break;
    case '/waktu-solat': renderWaktuSolatPage(container); break;
    case '/reminders': renderRemindersPage(container); break;
    default: container.innerHTML = '<div class="state-message"><div class="state-icon">🔍</div><div class="state-title">Page not found</div></div>';
  }
}

// ── Auth ────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const headers = { ...opts.headers };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return fetch(url, { ...opts, headers });
}

async function loginWithToken(botToken) {
  const btn = $('#token-login-form button');
  btn.textContent = '⟳ Verifying...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: botToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    localStorage.setItem('jarvis_token', data.token);
    state.user = data.user;
    state.token = data.token;
    state.isAuthenticated = true;
    updateUserUI();
    connectWebSocket();
    loadChatHistory();
    fetchProfilePhotos();
    navigate('/');
  } catch (err) {
    const errEl = $('#login-error');
    errEl.textContent = '⚠️ ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.textContent = '🔓 Login';
    btn.disabled = false;
  }
}

async function verifyToken() {
  if (!state.token) return false;
  try {
    // 5-second timeout — don't leave user staring at blank screen
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await api('/api/auth/me', { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('Invalid');
    const data = await res.json();
    state.user = data.user;
    state.isAuthenticated = true;
    updateUserUI();
    return true;
  } catch {
    // Token invalid or network error — silently fall through to login
    logout();
    return false;
  }
}

function logout() {
  localStorage.removeItem('jarvis_token');
  localStorage.removeItem('jarvis-widget-layout');
  state.user = null;
  state.token = null;
  state.isAuthenticated = false;
  if (state.wsRef) state.wsRef.close();
  clearTimeout(state.reconnectTimer);
  location.hash = '#/login';
}

function updateUserUI() {
  const u = state.user;
  const avatar = $('#user-avatar');
  const photoUrl = state.ownerPhoto || u?.photoUrl;
  if (photoUrl) {
    avatar.innerHTML = `<img src="${escapeHtml(photoUrl)}" alt="" class="avatar-img" />`;
  } else {
    avatar.innerHTML = `<span class="avatar-placeholder">${escapeHtml(u?.firstName?.[0] || '?')}</span>`;
  }
  $('#user-name').textContent = u?.firstName || 'User';
}

// Fetch Telegram profile photos for owner and bot
async function fetchProfilePhotos() {
  if (!state.token) return;
  try {
    const res = await api('/api/auth/photos');
    if (!res.ok) return;
    const data = await res.json();
    if (data.ownerPhoto) state.ownerPhoto = data.ownerPhoto;
    if (data.botPhoto) state.botPhoto = data.botPhoto;
    updateUserUI();
    updateChatUI();
  } catch { /* best-effort */ }
}

// ── Theme ───────────────────────────────────────────────────────────────
function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(pref) {
  const resolved = pref === 'system' ? getSystemTheme() : pref;
  state.themePref = pref;
  state.themeResolved = resolved;
  document.documentElement.setAttribute('data-theme', resolved);
  localStorage.setItem('jarvis-theme', pref);
  const btn = $('#theme-toggle-btn');
  if (btn) btn.textContent = resolved === 'dark' ? '☀️' : '🌙';
  if (btn) btn.title = `Switch to ${resolved === 'dark' ? 'light' : 'dark'} mode`;
}

function toggleTheme() {
  applyTheme(state.themeResolved === 'dark' ? 'light' : 'dark');
}

// ── WebSocket Chat ──────────────────────────────────────────────────────
function connectWebSocket() {
  if (!state.token) return;
  if (state.wsRef?.readyState === WebSocket.OPEN) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${state.token}`);
  state.wsRef = ws;

  ws.onopen = () => {
    state.wsConnected = true;
    updateConnectionStatus();
  };
  ws.onclose = () => {
    state.wsConnected = false;
    // Reset streaming state so user isn't stuck
    state.streaming = false;
    state.streamingText = '';
    updateConnectionStatus();
    updateChatUI();
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectWebSocket, 5000);
  };
  ws.onerror = () => { state.wsConnected = false; updateConnectionStatus(); };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'chunk':
        // LLM sends accumulated full text, not deltas — replace, don't append
        state.streamingText = msg.payload.text;
        updateChatUI();
        break;
      case 'done':
        // Skip empty done messages (just close streaming, no content to show)
        const doneText = msg.payload.fullText || state.streamingText;
        if (doneText || msg.payload.buttons) {
          state.messages.push({
            role: 'assistant', content: doneText,
            timestamp: new Date().toISOString(), model: msg.payload.metadata?.model,
            provider: msg.payload.metadata?.provider,
            toolResult: !!msg.payload.buttons,
            buttons: msg.payload.buttons || [],
          });
        }
        state.streaming = false;
        state.streamingText = '';
        persistMessages();
        updateChatUI();
        break;
      case 'tool_call':
        state.messages.push({
          role: 'tool', content: msg.payload.message, tool: msg.payload.tool,
          args: msg.payload.args, timestamp: new Date().toISOString(),
        });
        persistMessages();
        updateChatUI();
        break;
      case 'tool_result':
        state.messages.push({
          role: msg.payload.error ? 'system' : 'assistant',
          content: msg.payload.content, tool: msg.payload.tool,
          toolResult: true, buttons: msg.payload.buttons || [],
          timestamp: new Date().toISOString(),
        });
        persistMessages();
        updateChatUI();
        break;
      case 'error':
        state.messages.push({
          role: 'system', content: `Error: ${msg.payload.message}`,
          timestamp: new Date().toISOString(),
        });
        state.streaming = false;
        state.streamingText = '';
        persistMessages();
        updateChatUI();
        break;
    }
  };
}

function sendChatMessage(text) {
  if (!text.trim() || state.streaming) return;
  if (!state.wsRef || state.wsRef.readyState !== WebSocket.OPEN) {
    connectWebSocket();
    return;
  }
  state.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
  state.streaming = true;
  state.streamingText = '';
  persistMessages();
  updateChatUI();
  state.wsRef.send(JSON.stringify({ type: 'chat', payload: { message: text, model: state.model } }));
}

function cancelStream() {
  if (state.wsRef?.readyState === WebSocket.OPEN) {
    state.wsRef.send(JSON.stringify({ type: 'cancel', payload: {} }));
  }
  state.streaming = false;
  state.streamingText = '';
  updateChatUI();
}

function updateConnectionStatus() {
  $$('.chat-status-text').forEach(el => {
    el.textContent = state.wsConnected ? 'Connected' : 'Reconnecting...';
  });
  $$('.chat-status-dot').forEach(el => {
    el.className = `status-dot chat-status-dot ${state.wsConnected ? 'ok' : 'error'}`;
  });
}

// ── Render Helpers ──────────────────────────────────────────────────────
function esc(str) { return escapeHtml(String(str || '')); }
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Safely convert any value to a displayable string (prevents [object Object])
function safeContent(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    // Try common fields first
    return val.message || val.text || val.content || val.error || val.title || JSON.stringify(val);
  }
  return String(val);
}

function renderSkeleton(count, height) {
  return Array(count).fill(null).map(() => `<div class="skeleton" style="height:${height}px"></div>`).join('');
}

function renderMessageBubble(msg, isStreaming) {
  if (!msg) {
    // typing indicator
    return `<div class="message assistant"><div class="message-avatar">🤖</div><div class="message-body"><div class="message-content typing-indicator"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div></div></div>`;
  }

  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';
  const isTool = msg.role === 'tool';
  const isToolResult = msg.toolResult;

  let cls = 'message';
  if (isUser) cls += ' user';
  else if (isSystem) cls += ' system';
  else if (isTool) cls += ' tool-call';
  else if (isToolResult) cls += ' tool-result';
  else cls += ' assistant';
  if (isStreaming) cls += ' streaming';

  let avatar = state.botPhoto
    ? `<img src="${escapeHtml(state.botPhoto)}" class="avatar-img" style="width:30px;height:30px;border-radius:50%" />`
    : '🤖';
  if (isUser) {
    const photo = state.ownerPhoto || state.user?.photoUrl;
    avatar = photo
      ? `<img src="${escapeHtml(photo)}" class="avatar-img" style="width:30px;height:30px;border-radius:50%" />`
      : '👤';
  }
  else if (isSystem) avatar = '⚠️';
  else if (isTool) avatar = '🔧';
  else if (isToolResult) avatar = '✅';

  // Tool result with action buttons
  if (isToolResult && msg.buttons?.length) {
    // Backend sends buttons as array of rows: [[{text,action},...], [{text,action}]]
    // Flatten to single array for rendering
    const flatButtons = msg.buttons.flat ? msg.buttons.flat() : msg.buttons.reduce((acc, row) => acc.concat(row), []);
    const btns = flatButtons.map(b => {
      const label = b.label || b.text || (typeof b === 'string' ? b : 'Button');
      const action = b.action || '';
      return `<button class="btn btn-sm tool-btn" data-action="${esc(action)}">${esc(label)}</button>`;
    }).join(' ');
    return `<div class="${cls}"><div class="message-avatar">${avatar}</div><div class="message-body"><div class="message-content">${simpleMarkdown(safeContent(msg.content))}</div><div class="message-actions" style="opacity:1;margin-top:6px">${btns}</div></div></div>`;
  }

  if (isTool) {
    const toolName = (msg.tool || '').replace(/_/g, ' ');
    return `<div class="${cls}"><div class="message-avatar">${avatar}</div><div class="message-body"><div class="message-content tool-content"><span class="tool-icon">🔧</span><span class="tool-label">${esc(toolName)}</span></div></div></div>`;
  }

  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  let content = isUser ? `<p>${esc(safeContent(msg.content))}</p>` : simpleMarkdown(safeContent(msg.content));

  let meta = '';
  if (!isStreaming && msg.timestamp) {
    meta += `<div class="message-meta"><span class="message-time">${time}</span>`;
    if (msg.model) meta += `<span class="badge badge-purple">${esc(msg.model)}</span>`;
    meta += '</div>';
  }

  let actions = '';
  if (!isStreaming && !isUser && !isSystem) {
    actions = `<div class="message-actions"><button class="btn-icon" title="Copy" data-copy="${esc(safeContent(msg.content))}">📋</button></div>`;
  }

  let cursor = isStreaming ? '<span class="cursor-blink">▌</span>' : '';

  return `<div class="${cls}"><div class="message-avatar">${avatar}</div><div class="message-body"><div class="message-content">${content}${cursor}</div>${meta}${actions}</div></div>`;
}

function simpleMarkdown(text) {
  if (!text) return '';
  let html = esc(text);
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

// ── Chat Panel (sidebar) ────────────────────────────────────────────────
function updateChatUI() {
  // Only refresh message containers — do NOT re-render the entire page
  refreshMainChatMessages();
  refreshPanelChatMessages();
  // Update input bar state (stop/send button toggle, disabled state)
  refreshChatInputBar();
}

function refreshMainChatMessages() {
  const msgContainer = document.querySelector('.chat-msg-container');
  if (!msgContainer || currentRoute !== '/chat') return;
  renderChatMessages(msgContainer, false);
}

function refreshPanelChatMessages() {
  const msgArea = document.querySelector('#chat-panel-body .chat-messages');
  if (!msgArea) return;
  renderChatMessages(msgArea, true);
}

// Update the input bar without destroying/recreating it
function refreshChatInputBar() {
  const inputBars = document.querySelectorAll('.chat-input-bar');
  inputBars.forEach(bar => {
    const textarea = bar.querySelector('.chat-input-textarea');
    const sendBtn = bar.querySelector('.chat-send-btn');
    const cancelBtn = bar.querySelector('.chat-cancel-btn');

    // Update textarea state
    if (textarea) {
      textarea.placeholder = state.wsConnected ? 'Taip mesej...' : 'Connecting...';
      textarea.disabled = !state.wsConnected;
    }

    // Toggle send/cancel button visibility
    if (sendBtn) sendBtn.style.display = state.streaming ? 'none' : '';
    if (cancelBtn) cancelBtn.style.display = state.streaming ? '' : 'none';

    // If streaming but no cancel button exists, create one
    if (state.streaming && !cancelBtn) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-danger btn-sm chat-cancel-btn';
      cancel.textContent = '⏹ Stop';
      cancel.addEventListener('click', cancelStream);
      if (sendBtn) sendBtn.style.display = 'none';
      bar.querySelector('.chat-input-actions')?.appendChild(cancel);
    }

    // Update send button disabled state
    if (sendBtn) sendBtn.disabled = !state.wsConnected;
  });
}

function renderChatMessages(container, isPanel) {
  const msgs = state.messages;
  let html = '';

  if (msgs.length === 0 && !state.streaming) {
    const suggest = ['Apa khabar?', 'Apa berita hari ini?', 'Tolong ringkaskan nota saya', 'Waktu solat Zohor pukul berapa?'];
    html += `<div class="${isPanel ? 'chat-empty' : 'chat-page-empty'}">
      <div class="chat-empty-icon">🤖</div>
      ${isPanel ? '<div class="chat-empty-title">Chat Sidebar</div><div class="chat-empty-desc">Quick chat with Jarvis</div>'
        : '<h2>Chat dengan Jarvis</h2><p>Tanya apa-apa sahaja. Jarvis menggunakan ILMU & DeepSeek untuk menjawab soalan anda.</p><div class="chat-suggestions">'
        + suggest.map(s => `<button class="btn btn-sm chat-suggest-btn">${esc(s)}</button>`).join('') + '</div>'}
    </div>`;
  }

  msgs.forEach(msg => { html += renderMessageBubble(msg, false); });

  if (state.streaming) {
    if (state.streamingText) {
      html += renderMessageBubble({ role: 'assistant', content: state.streamingText, timestamp: new Date().toISOString() }, true);
    } else {
      html += renderMessageBubble(null, false); // typing indicator
    }
  }

  container.innerHTML = html + '<div class="chat-end-ref"></div>';
  // scroll to bottom
  const end = container.querySelector('.chat-end-ref');
  if (end) end.scrollIntoView({ behavior: 'smooth' });

  // Bind suggestion clicks
  container.querySelectorAll('.chat-suggest-btn').forEach(btn => {
    btn.addEventListener('click', () => sendChatMessage(btn.textContent));
  });

  // Bind copy buttons
  container.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = '✅';
      setTimeout(() => { btn.textContent = '📋'; }, 1500);
    });
  });

  // Bind tool result buttons
  container.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const label = btn.textContent.trim();
      sendChatMessage(`${label} (${action})`);
    });
  });
}

function renderChatInput(container, isPanel) {
  container.insertAdjacentHTML('beforeend', `
    <form class="chat-input-bar chat-input-form">
      <textarea class="chat-textarea chat-input-textarea" placeholder="${state.wsConnected ? 'Taip mesej...' : 'Connecting...'}" rows="1" ${!state.wsConnected ? 'disabled' : ''}></textarea>
      <div class="chat-input-actions">
        ${state.streaming
      ? '<button type="button" class="btn btn-danger btn-sm chat-cancel-btn">⏹ Stop</button>'
      : `<button type="submit" class="btn btn-primary btn-sm chat-send-btn" ${!state.wsConnected ? 'disabled' : ''}>📤</button>`}
      </div>
    </form>
  `);

  const textarea = container.querySelector('.chat-input-textarea');
  const form = container.querySelector('.chat-input-form');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text || state.streaming) return;
    sendChatMessage(text);
    textarea.value = '';
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  });

  const cancelBtn = container.querySelector('.chat-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelStream);

  textarea.focus();
}

// ── Page Renderers ──────────────────────────────────────────────────────
function renderChatPage(container) {
  container.innerHTML = `<div class="chat-page fade-in">
    <div class="chat-page-header">
      <div class="chat-page-status">
        <span class="status-dot chat-status-dot ${state.wsConnected ? 'ok' : 'error'}"></span>
        <span class="chat-status-text">${state.wsConnected ? 'Connected' : 'Reconnecting...'}</span>
      </div>
    </div>
    <div class="chat-page-messages chat-msg-container"></div>
  </div>`;
  const msgContainer = container.querySelector('.chat-msg-container');
  renderChatMessages(msgContainer, false);
  renderChatInput(container, false);
}

function renderDashboard(container) {
  if (state.widgetLoading && state.widgets.length === 0) {
    container.innerHTML = `<div class="dashboard-loading">${renderSkeleton(3, 160)}</div>`;
    return;
  }
  if (state.widgetError && state.widgets.length === 0) {
    container.innerHTML = `<div class="state-message"><div class="state-icon">⚠️</div><div class="state-title">Failed to load widgets</div><div class="state-desc">${esc(state.widgetError)}</div><button class="btn btn-primary retry-widgets-btn" style="margin-top:16px">🔄 Retry</button></div>`;
    container.querySelector('.retry-widgets-btn')?.addEventListener('click', fetchWidgets);
    return;
  }
  if (state.widgets.length === 0) {
    container.innerHTML = `<div class="state-message"><div class="state-icon">📦</div><div class="state-title">No widgets yet</div><div class="state-desc">Enable plugins in the <a href="#/plugins">Plugin Manager</a> to add widgets to your dashboard.</div></div>`;
    return;
  }
  renderWidgetGrid(container);
}

// ── Widgets ─────────────────────────────────────────────────────────────
async function fetchWidgets() {
  state.widgetLoading = true;
  state.widgetError = null;
  try {
    const res = await api('/api/widgets');
    if (!res.ok) throw new Error('Failed to fetch widgets');
    const data = await res.json();
    state.widgets = data.widgets || [];
    persistWidgetCache(); // Cache for instant display on next open

    // Auto-add new widgets to layout
    const layoutIds = new Set(state.widgetLayout.map(l => l.widgetId));
    const newWidgets = state.widgets.filter(w => !layoutIds.has(w.widgetId));
    if (newWidgets.length > 0) {
      newWidgets.forEach((w, i) => {
        state.widgetLayout.push({
          widgetId: w.widgetId,
          x: (i * 2) % 4, y: Math.floor(state.widgetLayout.length / 2) + (i * 2),
          w: w.defaultSize?.w || 2, h: w.defaultSize?.h || 1,
        });
      });
      persistLayout();
    }
  } catch (err) {
    state.widgetError = err.message;
  } finally {
    state.widgetLoading = false;
  }
}

function renderWidgetGrid(container) {
  const gridItems = state.widgetLayout.map(item => {
    const widget = state.widgets.find(w => w.widgetId === item.widgetId);
    return widget ? { ...item, widget } : null;
  }).filter(Boolean);

  container.innerHTML = `<div class="widget-grid">${gridItems.map(item => `
    <div class="widget-cell" style="grid-column:span ${item.w || 2};grid-row:span ${item.h || 1}">
      <div class="widget-card card" data-widget-id="${esc(item.widgetId)}">
        <div class="widget-header">
          <div class="widget-title"><span class="widget-icon">${esc(item.widget.icon || '📦')}</span><span>${esc(item.widget.title || '')}</span></div>
          <div class="widget-actions">
            <span class="widget-loading-indicator">⟳</span>
            <button class="btn-icon widget-remove-btn" title="Remove widget">✕</button>
          </div>
        </div>
        <div class="widget-body"><div class="skeleton" style="height:80px;min-height:80px"></div></div>
      </div>
    </div>
  `).join('')}</div>`;

  // Bind remove buttons
  container.querySelectorAll('.widget-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.widget-card').dataset.widgetId;
      state.widgetLayout = state.widgetLayout.filter(l => l.widgetId !== id);
      persistLayout();
      renderWidgetGrid(container);
    });
  });

  // Load widget data
  gridItems.forEach(item => {
    loadWidgetData(item.widget, container.querySelector(`[data-widget-id="${item.widgetId}"]`));
  });
}

async function loadWidgetData(widget, cardEl) {
  if (!widget?.endpoint || !cardEl) return;
  const loadingEl = cardEl.querySelector('.widget-loading-indicator');
  const bodyEl = cardEl.querySelector('.widget-body');

  try {
    const res = await api(widget.endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (loadingEl) loadingEl.style.display = 'none';
    bodyEl.innerHTML = renderWidgetContent(widget, data);

    // Auto-refresh
    if (widget.refreshInterval > 0) {
      setInterval(async () => {
        try {
          const r = await api(widget.endpoint);
          if (r.ok) {
            const d = await r.json();
            bodyEl.innerHTML = renderWidgetContent(widget, d);
          }
        } catch { }
      }, widget.refreshInterval);
    }
  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    bodyEl.innerHTML = `<div class="widget-error">⚠️ ${esc(err.message)}</div>`;
  }
}

function renderWidgetContent(widget, data) {
  switch (widget.type) {
    case 'list': return renderListWidget(data);
    case 'chart': return renderChartWidget(data);
    default: return renderCardWidget(data);
  }
}

function renderCardWidget(data) {
  if (!data) return '<div class="card-widget-empty">No data available</div>';

  if (data.timings) {
    const OBLIGATORY = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const LABELS = { fajr: 'Subuh', dhuhr: 'Zohor', asr: 'Asar', maghrib: 'Maghrib', isha: 'Isyak' };
    let html = data.hijri ? `<div class="prayer-hijri">${esc(data.hijri)}H</div>` : '';
    html += '<div class="prayer-times-list">';
    OBLIGATORY.forEach(key => {
      const time = data.timings[key];
      if (!time) return;
      const [h, m] = time.split(':');
      const d = new Date();
      d.setHours(parseInt(h), parseInt(m), 0);
      const t12 = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      html += `<div class="prayer-row"><span class="prayer-label">${LABELS[key]}</span><span class="prayer-time">${t12}</span></div>`;
    });
    html += '</div>';
    if (data.metadata?.serverTime) {
      html += `<div class="widget-footer-text">🟢 Live · ${new Date(data.metadata.serverTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>`;
    }
    return `<div class="card-widget">${html}</div>`;
  }

  if (data.weekStart && data.weekEnd) {
    return `<div class="card-widget">
      <div class="weekly-period">${new Date(data.weekStart).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })} – ${new Date(data.weekEnd).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
      <div class="card-row"><span class="card-label">Messages</span><span class="card-value">${data.messageCount ?? data.totalMessages ?? 0}</span></div>
      ${data.totalMoods !== undefined ? `<div class="card-row"><span class="card-label">Moods tracked</span><span class="card-value">${data.totalMoods}</span></div>` : ''}
    </div>`;
  }

  // Generic: show key-value pairs
  const entries = Object.entries(data).filter(([, v]) => typeof v !== 'object').slice(0, 6);
  if (entries.length === 0) return '<div class="card-widget-empty">No data available</div>';
  return `<div class="card-widget">${entries.map(([k, v]) => `<div class="card-row"><span class="card-label">${esc(k.replace(/_/g, ' '))}</span><span class="card-value">${esc(String(v))}</span></div>`).join('')}</div>`;
}

function renderListWidget(data) {
  if (!data) return '<div class="list-widget-empty">No data available</div>';
  const items = Array.isArray(data) ? data : (data.items || data.facts || data.tasks || data.notes || data.moods || []);
  if (!Array.isArray(items) || items.length === 0) return '<div class="list-widget-empty">No items to display</div>';

  let html = '<div class="list-widget">';
  items.slice(0, 10).forEach(item => {
    const text = item.title || item.key || item.label || item.mood || item.name || 'Item';
    html += `<div class="list-item"><span class="list-item-text">${esc(String(text))}</span>`;
    if (item.value) html += `<span class="list-item-value">${esc(String(item.value).slice(0, 40))}</span>`;
    if (item.count !== undefined) html += `<span class="badge badge-purple">${item.count}</span>`;
    html += '</div>';
  });
  if (items.length > 10) html += `<div class="list-footer">+${items.length - 10} more items</div>`;
  html += '</div>';
  return html;
}

function renderChartWidget(data) {
  if (!data) return '<div class="chart-widget-empty">No data available</div>';

  const moods = data.moods || data;
  if (Array.isArray(moods) && moods.length > 0) {
    const moodCounts = {};
    moods.forEach(m => { const mood = m.mood || m.key || m.label || 'unknown'; moodCounts[mood] = (moodCounts[mood] || 0) + 1; });
    const entries = Object.entries(moodCounts).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...entries.map(([, c]) => c), 1);
    const total = entries.reduce((sum, [, c]) => sum + c, 0);
    return `<div class="chart-widget"><div class="chart-total">Total: ${total}</div>${entries.map(([mood, count]) => `
      <div class="chart-bar-row"><span class="chart-bar-label">${esc(mood)}</span><div class="chart-bar-track"><div class="chart-bar-fill accent" style="width:${(count / max) * 100}%"></div></div><span class="chart-bar-value">${count}</span></div>
    `).join('')}</div>`;
  }

  const numericEntries = Object.entries(data).filter(([, v]) => typeof v === 'number').slice(0, 6);
  if (numericEntries.length === 0) return '<div class="chart-widget-empty">No chart data</div>';
  const maxVal = Math.max(...numericEntries.map(([, v]) => v), 1);
  return `<div class="chart-widget">${numericEntries.map(([k, v]) => `
    <div class="chart-bar-row"><span class="chart-bar-label">${esc(k.replace(/_/g, ' '))}</span><div class="chart-bar-track"><div class="chart-bar-fill" style="width:${(v / maxVal) * 100}%"></div></div><span class="chart-bar-value">${v}</span></div>
  `).join('')}</div>`;
}

// ── Tasks Page ──────────────────────────────────────────────────────────
async function renderTasksPage(container) {
  container.innerHTML = `<div class="tasks-page fade-in"><div class="page-loading">${renderSkeleton(5, 56)}</div></div>`;
  try {
    const res = await api('/api/tasks');
    if (!res.ok) throw new Error('Failed to fetch tasks');
    const data = await res.json();
    const tasks = data.tasks || [];
    let activeTab = 'all';

    function filter() { return activeTab === 'all' ? tasks : tasks.filter(t => t.status === activeTab); }
    const tabs = [{ key: 'all', label: 'All' }, { key: 'pending', label: '📋 Todo' }, { key: 'in_progress', label: '🟡 In Progress' }, { key: 'done', label: '✅ Done' }];

    function draw() {
      const filtered = filter();
      container.querySelector('.tasks-page').innerHTML = `
        <form class="task-add-form"><input type="text" class="task-add-input" placeholder="Add a new task..." /><button type="submit" class="btn btn-primary btn-sm">+ Add</button></form>
        <div class="task-tabs">${tabs.map(t => `<button class="btn btn-sm task-tab-btn ${activeTab === t.key ? 'btn-primary' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}</div>
        <div class="task-list">${filtered.map(t => `
          <div class="task-item ${t.status === 'done' ? 'done' : ''}">
            <div class="task-info">
              <div class="task-title">${esc(t.title)}</div>
              <div class="task-meta">
                <span class="badge ${t.priority === 'high' ? 'badge-red' : t.priority === 'medium' ? 'badge-yellow' : 'badge-green'}">${esc(t.priority || 'medium')}</span>
                <span class="task-date">${new Date(t.created_at).toLocaleDateString()}</span>
              </div>
            </div>
            <div class="task-actions">
              ${t.status !== 'done' ? `<button class="btn btn-sm btn-primary task-done-btn" data-id="${esc(t.id)}">✅</button>` : ''}
              <button class="btn btn-sm btn-danger task-delete-btn" data-id="${esc(t.id)}">🗑</button>
            </div>
          </div>
        `).join('')}</div>
      `;
      bindTaskEvents();
    }

    async function bindTaskEvents() {
      container.querySelector('.task-add-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = container.querySelector('.task-add-input');
        if (!input.value.trim()) return;
        await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: input.value.trim(), priority: 'medium' }) });
        input.value = '';
        renderTasksPage(container);
      });
      container.querySelectorAll('.task-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => { activeTab = btn.dataset.tab; draw(); });
      });
      container.querySelectorAll('.task-done-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await api(`/api/tasks/${btn.dataset.id}`, { method: 'PUT', body: JSON.stringify({ status: 'done' }) });
          renderTasksPage(container);
        });
      });
      container.querySelectorAll('.task-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await api(`/api/tasks/${btn.dataset.id}`, { method: 'DELETE' });
          renderTasksPage(container);
        });
      });
    }

    draw();
  } catch (err) {
    container.innerHTML = `<div class="tasks-page fade-in"><div class="login-error">⚠️ ${esc(err.message)}</div></div>`;
  }
}

// ── Notes Page ──────────────────────────────────────────────────────────
async function renderNotesPage(container) {
  container.innerHTML = `<div class="notes-page fade-in"><div class="page-loading">${renderSkeleton(4, 80)}</div></div>`;

  async function draw(showEditor) {
    try {
      const res = await api('/api/notes');
      if (!res.ok) throw new Error('Failed to fetch notes');
      const data = await res.json();
      const notes = data.notes || [];

      container.querySelector('.notes-page').innerHTML = `
        <div class="notes-header"><h2>📝 Notes</h2><button class="btn btn-primary notes-toggle-btn">${showEditor ? '✕ Cancel' : '+ New Note'}</button></div>
        ${showEditor ? `<form class="note-editor card notes-form">
          <input type="text" class="note-title-input" placeholder="Note title (optional)" />
          <textarea class="note-content-input" placeholder="Write your note..."></textarea>
          <div class="note-editor-actions"><button type="submit" class="btn btn-primary btn-sm">💾 Save</button></div>
        </form>` : ''}
        <div class="notes-grid">${notes.map(n => `
          <div class="note-card card">
            <div class="note-card-title">${esc(n.title || 'Untitled')}</div>
            <div class="note-card-body">${esc(n.content || '')}</div>
            <div class="note-card-footer">
              <span class="note-card-date">${new Date(n.created_at).toLocaleDateString()}</span>
              <button class="btn btn-sm btn-danger notes-delete-btn" data-id="${esc(n.id)}">🗑</button>
            </div>
          </div>
        `).join('')}</div>
      `;

      container.querySelector('.notes-toggle-btn')?.addEventListener('click', () => draw(!showEditor));
      container.querySelectorAll('.notes-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await api(`/api/notes/${btn.dataset.id}`, { method: 'DELETE' });
          draw(false);
        });
      });
      container.querySelector('.notes-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = container.querySelector('.note-title-input').value.trim();
        const content = container.querySelector('.note-content-input').value.trim();
        if (!content && !title) return;
        await api('/api/notes', { method: 'POST', body: JSON.stringify({ title: title || undefined, content }) });
        draw(false);
      });
    } catch (err) {
      container.innerHTML = `<div class="notes-page fade-in"><div class="login-error">⚠️ ${esc(err.message)}</div></div>`;
    }
  }

  draw(false);
}

// ── Memory Page ─────────────────────────────────────────────────────────
async function renderMemoryPage(container) {
  container.innerHTML = `<div class="memory-page fade-in"><div class="page-loading">${renderSkeleton(6, 52)}</div></div>`;

  async function draw(search) {
    try {
      const url = search ? `/api/memory/facts?search=${encodeURIComponent(search)}` : '/api/memory/facts';
      const res = await api(url);
      if (!res.ok) throw new Error('Failed to fetch memory');
      const data = await res.json();
      const facts = data.facts || [];

      function confidenceBadge(c) { const p = parseInt(c) || 50; return p >= 80 ? `<span class="badge badge-green">🟢 ${p}%</span>` : p >= 50 ? `<span class="badge badge-yellow">🟡 ${p}%</span>` : `<span class="badge badge-red">🔴 ${p}%</span>`; }

      container.querySelector('.memory-page').innerHTML = `
        <div class="memory-header">
          <h2>🧠 Memory Browser</h2>
          <div class="memory-search">
            <input type="text" class="memory-search-input" placeholder="🔍 Search facts..." value="${esc(search || '')}" />
            <button class="btn btn-sm btn-primary memory-search-btn">Search</button>
          </div>
        </div>
        <div class="memory-stats"><span class="badge badge-purple">${facts.length} facts</span></div>
        <div class="memory-table">
          <div class="memory-table-header"><span>Key</span><span>Value</span><span>Confidence</span><span>Actions</span></div>
          ${facts.map(f => `
            <div class="memory-row" data-key="${esc(f.key)}">
              <span class="mem-col-key">${esc(f.key)}</span>
              <span class="mem-col-value">${esc(String(f.value || ''))}</span>
              <span class="mem-col-confidence">${confidenceBadge(f.confidence)}</span>
              <span class="mem-col-actions">
                <button class="btn btn-sm mem-edit-btn" data-key="${esc(f.key)}" data-val="${esc(String(f.value || ''))}">✏️</button>
                <button class="btn btn-sm btn-danger mem-delete-btn" data-key="${esc(f.key)}">🗑</button>
              </span>
            </div>
          `).join('')}
        </div>
      `;

      container.querySelector('.memory-search-btn')?.addEventListener('click', () => {
        draw(container.querySelector('.memory-search-input').value);
      });
      container.querySelector('.memory-search-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') draw(e.target.value);
      });
      container.querySelectorAll('.mem-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.memory-row');
          const key = btn.dataset.key;
          const val = btn.dataset.val;
          row.querySelector('.mem-col-value').innerHTML = `<span class="mem-edit-inline"><input type="text" value="${esc(val)}" class="mem-edit-input" /><button class="btn btn-sm btn-primary mem-save-btn">💾</button><button class="btn btn-sm mem-cancel-btn">✕</button></span>`;
          row.querySelector('.mem-save-btn').addEventListener('click', async () => {
            const newVal = row.querySelector('.mem-edit-input').value;
            await api(`/api/memory/facts/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value: newVal }) });
            draw(search);
          });
          row.querySelector('.mem-cancel-btn').addEventListener('click', () => draw(search));
        });
      });
      container.querySelectorAll('.mem-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Delete fact: "${btn.dataset.key}"?`)) return;
          await api(`/api/memory/facts/${encodeURIComponent(btn.dataset.key)}`, { method: 'DELETE' });
          draw(search);
        });
      });
    } catch (err) {
      container.innerHTML = `<div class="memory-page fade-in"><div class="login-error">⚠️ ${esc(err.message)}</div></div>`;
    }
  }

  draw('');
}

// ── Plugins Page ────────────────────────────────────────────────────────
async function renderPluginsPage(container) {
  container.innerHTML = `<div class="plugins-page fade-in"><div class="page-loading">${renderSkeleton(3, 120)}</div></div>`;

  async function draw() {
    try {
      const res = await api('/api/plugins');
      if (!res.ok) throw new Error('Failed to fetch plugins');
      const data = await res.json();
      const plugins = data.plugins || [];

      container.querySelector('.plugins-page').innerHTML = `
        <div class="plugins-header"><h2>🔌 Plugin Manager</h2></div>
        <div class="plugins-list">${plugins.map(p => `
          <div class="plugin-card card ${p.state === 'error' ? 'error' : ''}">
            <div class="plugin-card-top">
              <div>
                <div class="plugin-name">${p.state === 'enabled' ? '🟢' : p.state === 'error' ? '❌' : '🔴'} ${esc(p.name)} <span class="plugin-version">v${esc(p.version || '1.0.0')}</span></div>
                <div class="plugin-desc">${esc(p.description || '')}</div>
                <div class="plugin-meta">
                  ${p.tags ? `<div class="plugin-tags">${p.tags.map(t => `<code>${esc(t)}</code>`).join('')}</div>` : ''}
                  <span class="plugin-author">by ${esc(p.author || 'unknown')}</span>
                </div>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" class="plugin-toggle" data-name="${esc(p.name)}" ${p.state === 'enabled' ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="plugin-actions">
              <button class="btn btn-sm plugin-reload-btn" data-name="${esc(p.name)}">🔄 Reload</button>
            </div>
          </div>
        `).join('')}</div>
      `;

      container.querySelectorAll('.plugin-toggle').forEach(toggle => {
        toggle.addEventListener('change', async () => {
          toggle.disabled = true;
          await api(`/api/plugins/${toggle.dataset.name}/toggle`, { method: 'POST', body: JSON.stringify({ enabled: toggle.checked }) });
          draw();
        });
      });
      container.querySelectorAll('.plugin-reload-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = '⟳ Reloading...';
          await api(`/api/plugins/${btn.dataset.name}/reload`, { method: 'POST' });
          draw();
        });
      });
    } catch (err) {
      container.innerHTML = `<div class="plugins-page fade-in"><div class="login-error">⚠️ ${esc(err.message)}</div></div>`;
    }
  }

  draw();
}

// ── Settings Page ──────────────────────────────────────────────────────
function renderSettingsPage(container) {
  const u = state.user;
  container.innerHTML = `<div class="settings-page fade-in">
    <div class="settings-section card">
      <h3>👤 Profile</h3>
      <div class="setting-row"><label>Name</label><input type="text" value="${esc(u?.firstName || '')}" readonly disabled /></div>
      <div class="setting-row"><label>Telegram ID</label><input type="text" value="${esc(u?.sub || '')}" readonly disabled /></div>
      ${u?.username ? `<div class="setting-row"><label>Username</label><input type="text" value="@${esc(u.username)}" readonly disabled /></div>` : ''}
    </div>
    <div class="settings-section card">
      <h3>🎨 Appearance</h3>
      <div class="setting-row">
        <label>Theme</label>
        <div class="theme-options">
          ${[{ v: 'dark', i: '🌙', l: 'Dark' }, { v: 'light', i: '☀️', l: 'Light' }, { v: 'system', i: '💻', l: 'System' }].map(o => `
            <button class="btn btn-sm theme-opt-btn ${state.themePref === o.v ? 'btn-primary' : ''}" data-theme="${o.v}">${o.i} ${o.l}</button>
          `).join('')}
        </div>
      </div>
    </div>
    <div class="settings-section card">
      <h3>🤖 AI Defaults</h3>
      <div class="setting-row"><label>Language</label><select><option value="auto">Auto-detect</option><option value="ms">Bahasa Melayu</option><option value="en">English</option></select></div>
    </div>
    <div class="settings-section card">
      <h3>📋 About</h3>
      <div class="about-info">
        <p><strong>Jarvis Playground</strong> ${APP_VERSION}</p>
        <p>Personal AI Assistant Dashboard</p>
        <p class="about-stack">Built with Vanilla JS · Express · PostgreSQL · ILMU · DeepSeek</p>
      </div>
    </div>
    <div class="settings-section"><button class="btn btn-danger settings-logout-btn">🚪 Logout</button></div>
  </div>`;

  container.querySelectorAll('.theme-opt-btn').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
  container.querySelector('.settings-logout-btn')?.addEventListener('click', logout);
}

// ── Waktu Solat Page ────────────────────────────────────────────────────
const PRAYER_ORDER = ['imsak', 'fajr', 'syuruk', 'dhuha', 'dhuhr', 'asr', 'maghrib', 'isha'];
const PRAYER_LABELS = { imsak: 'Imsak', fajr: 'Subuh', syuruk: 'Syuruk', dhuha: 'Dhuha', dhuhr: 'Zohor', asr: 'Asar', maghrib: 'Maghrib', isha: 'Isyak' };
const PRAYER_ICONS = { imsak: '🌙', fajr: '🌅', syuruk: '☀️', dhuha: '🌤️', dhuhr: '☀️', asr: '🌤️', maghrib: '🌇', isha: '🌙' };
const OBLIGATORY = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

async function renderWaktuSolatPage(container) {
  let zone = localStorage.getItem('prayerZone') || 'SGR01';
  container.innerHTML = `<div class="ws-page fade-in"><div class="ws-card card"><div class="skeleton" style="height:200px"></div></div></div>`;

  // Fetch available zones once
  let zones = {};
  try {
    const zRes = await fetch('/api/prayertimes/zones');
    if (zRes.ok) zones = await zRes.json();
  } catch { }

  // Build zone options grouped by state
  function buildZoneOptions() {
    if (!Object.keys(zones).length) {
      return `<option value="${esc(zone)}">${esc(zone)}</option>`;
    }
    const stateNames = {
      WLY: 'WP', SGR: 'Selangor', JHR: 'Johor', KDH: 'Kedah', KTN: 'Kelantan',
      MLK: 'Melaka', NGS: 'N. Sembilan', PHG: 'Pahang', PRK: 'Perak',
      PLS: 'Perlis', PNG: 'P. Pinang', SBH: 'Sabah', SWK: 'Sarawak', TRG: 'Terengganu',
    };
    const entries = Object.entries(zones);
    // Sort by state code
    entries.sort(([a], [b]) => a.localeCompare(b));
    let html = '';
    let currentState = '';
    entries.forEach(([code, label]) => {
      const prefix = code.slice(0, 3);
      const state = stateNames[prefix] || prefix;
      if (state !== currentState) {
        if (currentState) html += '</optgroup>';
        html += `<optgroup label="${esc(state)}">`;
        currentState = state;
      }
      html += `<option value="${esc(code)}" ${zone === code ? 'selected' : ''}>${esc(code)} - ${esc(label)}</option>`;
    });
    html += '</optgroup>';
    return html;
  }

  async function draw() {
    try {
      const res = await fetch(`/api/prayertimes?zone=${encodeURIComponent(zone)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const now = new Date();
      let nextPrayer = null;

      const prayerRows = PRAYER_ORDER.map(key => {
        const time = data.timings?.[key];
        if (!time) return '';
        // API returns HH:MM:SS format — just use directly
        const [h, m] = time.split(':').map(Number);
        const pd = new Date(`${now.toISOString().split('T')[0]}T${time}+08:00`);
        const isPast = pd < now;
        const isNext = OBLIGATORY.includes(key) && pd > now && !nextPrayer;
        if (isNext) nextPrayer = { key, date: pd };

        const t12 = new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        return `<div class="ws-prayer-row ${isPast ? 'past' : ''} ${isNext ? 'next' : ''}">
          <div class="ws-prayer-left"><span class="ws-prayer-icon">${PRAYER_ICONS[key] || '🕐'}</span><span class="ws-prayer-name">${PRAYER_LABELS[key] || key}</span></div>
          <span class="ws-prayer-time">${t12}</span>
        </div>`;
      }).join('');

      let countdown = '';
      if (nextPrayer) {
        const diff = nextPrayer.date - now;
        const hh = Math.floor(diff / 3600000);
        const mm = Math.floor((diff % 3600000) / 60000);
        countdown = `<div class="ws-countdown">⏳ ${PRAYER_LABELS[nextPrayer.key]} dalam ${hh}j ${mm}m</div>`;
      }

      const gregorian = data.date || now.toLocaleDateString('en-MY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      container.querySelector('.ws-card').innerHTML = `
        <div class="ws-date-card">
          <div class="ws-gregorian">${gregorian}</div>
          ${data.hijri ? `<div class="ws-hijri">${esc(data.hijri)}H</div>` : ''}
          <div class="ws-day">${data.day || ''}</div>
        </div>
        <div class="ws-zone">
          <select class="ws-zone-select">${buildZoneOptions()}</select>
        </div>
        <div class="ws-prayers">${prayerRows}</div>
        ${countdown}
        <div class="ws-footer">🟢 Live · ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</div>
      `;

      container.querySelector('.ws-zone-select').addEventListener('change', (e) => {
        zone = e.target.value;
        localStorage.setItem('prayerZone', zone);
        draw();
      });

      // Live countdown timer (update every 30s)
      const countdownInterval = setInterval(() => {
        const now2 = new Date();
        let nextP = null;
        OBLIGATORY.forEach(key => {
          const time2 = data.timings?.[key];
          if (!time2) return;
          const pd2 = new Date(`${now2.toISOString().split('T')[0]}T${time2}+08:00`);
          if (pd2 > now2 && !nextP) nextP = { key, date: pd2 };
        });
        const cdEl = container.querySelector('.ws-countdown');
        if (cdEl && nextP) {
          const diff2 = nextP.date - now2;
          const hh2 = Math.floor(diff2 / 3600000);
          const mm2 = Math.floor((diff2 % 3600000) / 60000);
          cdEl.textContent = `⏳ ${PRAYER_LABELS[nextP.key]} dalam ${hh2}j ${mm2}m`;
        }
        const footerEl = container.querySelector('.ws-footer');
        if (footerEl) {
          footerEl.textContent = `🟢 Live · ${now2.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
        }
      }, 30000);
      container._wsCountdownInterval = countdownInterval;
    } catch (err) {
      container.innerHTML = `<div class="ws-page fade-in"><div class="login-error">⚠️ ${esc(err.message)}</div></div>`;
    }
  }

  draw();
}

// ── Reminders Page ─────────────────────────────────────────────────────
async function renderRemindersPage(container) {
  container.innerHTML = `<div class="reminders-page fade-in"><div class="page-loading">${renderSkeleton(4, 60)}</div></div>`;

  async function draw(showAdd) {
    try {
      const res = await api('/api/reminders');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      const reminders = data.reminders || [];

      container.querySelector('.reminders-page').innerHTML = `
        <div class="reminders-header"><h2>⏰ Reminders</h2><button class="btn btn-primary reminders-toggle-btn">${showAdd ? '✕ Cancel' : '+ New Reminder'}</button></div>
        ${showAdd ? `<form class="reminder-form card reminders-add-form">
          <input type="text" class="reminder-text-input" placeholder="What do you want to be reminded about?" required />
          <div class="reminder-form-row">
            <input type="datetime-local" class="reminder-date-input" required />
            <select class="reminder-recur-input"><option value="">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
          </div>
          <div class="note-editor-actions"><button type="submit" class="btn btn-primary btn-sm">💾 Save</button></div>
        </form>` : ''}
        <div class="reminders-list">${reminders.map(r => `
          <div class="reminder-card card ${r.status === 'done' ? 'done' : ''}">
            <div>
              <div class="reminder-text">${esc(r.text)}</div>
              <div class="reminder-meta">
                <span>📅 ${new Date(r.remind_at).toLocaleString('en-MY', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                ${r.recurrence ? `<span>🔁 ${esc(r.recurrence)}</span>` : ''}
              </div>
            </div>
            <button class="btn btn-sm btn-danger reminders-cancel-btn" data-id="${esc(r.id)}">🗑</button>
          </div>
        `).join('')}</div>
      `;

      container.querySelector('.reminders-toggle-btn')?.addEventListener('click', () => draw(!showAdd));
      container.querySelectorAll('.reminders-cancel-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await api(`/api/reminders/${btn.dataset.id}`, { method: 'DELETE' });
          draw(false);
        });
      });
      container.querySelector('.reminders-add-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = container.querySelector('.reminder-text-input').value.trim();
        const remindAt = container.querySelector('.reminder-date-input').value;
        const recurrence = container.querySelector('.reminder-recur-input').value;
        if (!text || !remindAt) return;
        await api('/api/reminders', { method: 'POST', body: JSON.stringify({ text, remindAt, recurrence: recurrence || null }) });
        draw(false);
      });
    } catch (err) {
      container.innerHTML = `<div class="reminders-page fade-in"><div class="login-error">⚠️ ${esc(err.message)}</div></div>`;
    }
  }

  draw(false);
}

// ── Telegram OAuth Widget ──────────────────────────────────────────────
async function loadTelegramWidget() {
  try {
    const res = await fetch('/api/auth/bot-info');
    const info = await res.json();
    const container = $('#telegram-widget-container');
    if (!container) return;

    if (!info.configured) {
      container.innerHTML = `<p class="login-note">
        <strong>⚠️ Not configured yet.</strong><br>
        Open <strong>@BotFather</strong> → <code>/setdomain</code> →
        <code>@ApizrBot</code> → <code>playground.hafizrodzli.com</code><br>
        Then add <code>TELEGRAM_BOT_USERNAME=@ApizrBot</code> to VPS .env and run <code>npm run deploy</code>.
      </p>`;
      return;
    }

    // Define global callback before script loads
    window.onTelegramAuth = async (user) => {
      try {
        const res = await fetch('/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(user),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
        localStorage.setItem('jarvis_token', data.token);
        state.user = data.user;
        state.token = data.token;
        state.isAuthenticated = true;
        updateUserUI();
        connectWebSocket();
        fetchWidgets();
        loadChatHistory();
        fetchProfilePhotos();
        setInterval(fetchWidgets, 60000);
        setInterval(loadChatHistory, 30000);
        navigate('/');
      } catch (err) {
        const errEl = $('#login-error');
        errEl.textContent = '⚠️ ' + err.message;
        errEl.classList.remove('hidden');
      }
    };

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', info.botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '10');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);
  } catch {
    // Silently ignore — widget is optional
  }
}

// ── Chat History Persistence ───────────────────────────────────────────
// Loads chat history from server DB — restores messages even if PWA was closed
async function loadChatHistory() {
  if (!state.token) return;
  try {
    const res = await api('/api/chat/history?limit=50');
    if (!res.ok) return;
    const data = await res.json();
    const serverMsgs = data.messages || [];
    if (serverMsgs.length === 0) return;

    // Merge: only add server messages not already in our local list
    // Compare by content + role to avoid duplicates
    const localSet = new Set(state.messages.map(m => `${m.role}::${m.content?.slice(0, 80)}`));
    let hasNew = false;

    serverMsgs.forEach(sm => {
      const key = `${sm.role}::${(sm.content || '').slice(0, 80)}`;
      if (!localSet.has(key)) {
        state.messages.push({
          role: sm.role,
          content: sm.content,
          timestamp: sm.created_at || new Date().toISOString(),
        });
        hasNew = true;
      }
    });

    if (hasNew) {
      // Keep chronological order and deduplicate
      state.messages = state.messages.filter((m, i, arr) => {
        return arr.findIndex(x => x.role === m.role && x.content === m.content) === i;
      });
      persistMessages();
    }
  } catch (e) {
    // Silent — history loading is best-effort
  }
}

// ── Init ────────────────────────────────────────────────────────────────
function init() {
  // ── Immediately show the right page (no blank flash) ──────────────
  if (state.token) {
    $('#page-login').classList.add('hidden');
    $('#page-app').classList.remove('hidden');
  } else {
    $('#page-app').classList.add('hidden');
    $('#page-login').classList.remove('hidden');
  }

  // Build sidebar nav
  const sidebarNav = $('#sidebar-nav');
  sidebarNav.innerHTML = NAV_ITEMS.map(item => `
    <div class="nav-item" data-to="${item.to}" title="${esc(item.label)}">
      <span class="nav-icon">${item.icon}</span>
      <span class="nav-label">${esc(item.label)}</span>
    </div>
  `).join('');

  // Build mobile nav
  const mobileNav = $('#mobile-nav');
  mobileNav.innerHTML = MOBILE_NAV.map(item => `
    <div class="mobile-nav-item" data-to="${item.to}">
      <span class="mobile-nav-icon">${item.icon}</span>
      <span class="mobile-nav-label">${esc(item.label)}</span>
    </div>
  `).join('');

  // Bind nav clicks
  $$('.nav-item, .mobile-nav-item').forEach(el => {
    el.addEventListener('click', () => {
      navigate(el.dataset.to);
      // Close mobile sidebar
      $('#sidebar').classList.remove('mobile-open');
      $('#mobile-overlay').classList.add('hidden');
    });
  });

  // Sidebar collapse
  $('#sidebar-logo-btn').addEventListener('click', () => {
    $('#sidebar').classList.toggle('collapsed');
    const btn = $('#collapse-btn');
    btn.textContent = $('#sidebar').classList.contains('collapsed') ? '▶' : '◀';
  });
  $('#collapse-btn').addEventListener('click', () => {
    $('#sidebar').classList.toggle('collapsed');
    const btn = $('#collapse-btn');
    btn.textContent = $('#sidebar').classList.contains('collapsed') ? '▶' : '◀';
  });

  // Mobile menu
  $('#menu-btn').addEventListener('click', () => {
    $('#sidebar').classList.add('mobile-open');
    $('#mobile-overlay').classList.remove('hidden');
  });
  $('#mobile-overlay').addEventListener('click', () => {
    $('#sidebar').classList.remove('mobile-open');
    $('#mobile-overlay').classList.add('hidden');
  });

  // Theme
  $('#theme-toggle-btn').addEventListener('click', toggleTheme);
  applyTheme(state.themePref);

  // Logout
  $('#logout-btn').addEventListener('click', logout);

  // Chat panel toggle
  const panel = $('#chat-panel');
  const panelBody = $('#chat-panel-body');
  $('#chat-panel-header')?.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    const btn = $('#chat-panel-toggle');
    btn.textContent = panel.classList.contains('collapsed') ? '◀' : '▶';
    if (!panel.classList.contains('collapsed')) {
      // Ensure messages wrapper exists (separate from input)
      let msgArea = panelBody.querySelector('.chat-messages');
      if (!msgArea) {
        panelBody.innerHTML = '<div class="chat-messages"></div>';
        msgArea = panelBody.querySelector('.chat-messages');
      }
      renderChatMessages(msgArea, true);
      // Add input if not present
      if (!panelBody.querySelector('.chat-input-bar')) {
        renderChatInput(panelBody, true);
      }
    }
  });

  // Login form
  $('#token-login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loginWithToken($('#bot-token-input').value.trim());
  });

  // Mobile responsive
  function checkMobile() {
    const isMobile = window.innerWidth <= 768;
    $('#menu-btn').classList.toggle('hidden', !isMobile);
    $('#chat-panel').classList.toggle('hidden-mobile', isMobile);
  }
  window.addEventListener('resize', checkMobile);
  checkMobile();

  // System theme listener
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.themePref === 'system') applyTheme('system');
  });

  // Hash router
  window.addEventListener('hashchange', renderRoute);

  // Ensure version marker exists for future cache invalidation
  localStorage.setItem('jarvis-app-version', APP_VERSION);

  // Update version display in login footer and settings
  const verEl = $('#login-version-text');
  if (verEl) verEl.textContent = APP_VERSION;

  // Load Telegram OAuth widget on login page
  loadTelegramWidget();

  // Init
  if (state.token) {
    // Restore last visited route so user lands where they left off
    const lastRoute = localStorage.getItem('jarvis-last-route');
    if (lastRoute && lastRoute !== '/login') {
      location.hash = '#' + lastRoute;
    }
    verifyToken().then(valid => {
      if (valid) {
        connectWebSocket();
        fetchWidgets();
        loadChatHistory();
        fetchProfilePhotos();
        setInterval(fetchWidgets, 60000);
        setInterval(loadChatHistory, 30000);
      }
      renderRoute();
    });
  } else {
    renderRoute();
  }
}

document.addEventListener('DOMContentLoaded', init);
