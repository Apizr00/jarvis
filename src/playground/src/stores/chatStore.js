import { create } from 'zustand';

const CHAT_KEY = 'jarvis_chat_messages';
const MODEL_KEY = 'jarvis_chat_model';

function loadMessages() {
  try { const s = localStorage.getItem(CHAT_KEY); return s ? JSON.parse(s) : []; } catch { return []; }
}
function saveMessages(msgs) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-100))); } catch { }
}

export const useChatStore = create((set, get) => ({
  messages: loadMessages(),
  streaming: false,
  streamingText: '',
  model: localStorage.getItem(MODEL_KEY) || 'auto',
  wsConnected: false,
  activeConversationId: null,

  addMessage: (msg) => set((s) => {
    const updated = [...s.messages, msg];
    saveMessages(updated);
    return { messages: updated };
  }),

  setStreaming: (streaming) => set({ streaming }),
  appendStreamText: (text) => set((s) => ({ streamingText: s.streamingText + text })),
  clearStreamText: () => set({ streamingText: '' }),

  finalizeStream: (fullText, metadata = {}) => {
    set((s) => {
      const updated = [...s.messages, {
        role: 'assistant',
        content: fullText || s.streamingText,
        timestamp: new Date().toISOString(),
        model: metadata.model,
        provider: metadata.provider,
      }];
      saveMessages(updated);
      return { messages: updated, streaming: false, streamingText: '' };
    });
  },

  addToolCall: (tool, args, message) => {
    set((s) => {
      const updated = [...s.messages, { role: 'tool', content: message, tool, args, timestamp: new Date().toISOString() }];
      saveMessages(updated);
      return { messages: updated };
    });
  },

  addToolResult: (tool, content, error) => {
    set((s) => {
      const updated = [...s.messages, { role: error ? 'system' : 'assistant', content, tool, toolResult: true, timestamp: new Date().toISOString() }];
      saveMessages(updated);
      return { messages: updated };
    });
  },

  setModel: (model) => {
    localStorage.setItem(MODEL_KEY, model);
    set({ model });
  },
  setWsConnected: (connected) => set({ wsConnected: connected }),
  setActiveConversationId: (id) => set({ activeConversationId: id }),

  clearChat: () => {
    localStorage.removeItem(CHAT_KEY);
    set({ messages: [], streaming: false, streamingText: '' });
  },
}));
