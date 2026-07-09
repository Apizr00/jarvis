import { create } from 'zustand';

export const useChatStore = create((set, get) => ({
  messages: [],        // [{ role, content, timestamp, model, tool?, toolResult? }]
  streaming: false,
  streamingText: '',
  model: 'auto',
  wsConnected: false,
  activeConversationId: null,

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

  setStreaming: (streaming) => set({ streaming }),
  appendStreamText: (text) => set((s) => ({ streamingText: s.streamingText + text })),
  clearStreamText: () => set({ streamingText: '' }),

  finalizeStream: (fullText, metadata = {}) => {
    set((s) => ({
      messages: [...s.messages, {
        role: 'assistant',
        content: fullText || s.streamingText,
        timestamp: new Date().toISOString(),
        model: metadata.model,
        provider: metadata.provider,
      }],
      streaming: false,
      streamingText: '',
    }));
  },

  addToolCall: (tool, args, message) => {
    set((s) => ({
      messages: [...s.messages, {
        role: 'tool',
        content: message,
        tool,
        args,
        timestamp: new Date().toISOString(),
      }],
    }));
  },

  addToolResult: (tool, content, error) => {
    set((s) => ({
      messages: [...s.messages, {
        role: error ? 'system' : 'assistant',
        content,
        tool,
        toolResult: true,
        timestamp: new Date().toISOString(),
      }],
    }));
  },

  setModel: (model) => set({ model }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
  setActiveConversationId: (id) => set({ activeConversationId: id }),

  clearChat: () => set({ messages: [], streaming: false, streamingText: '' }),
}));
