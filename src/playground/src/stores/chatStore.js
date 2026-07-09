import { create } from 'zustand';

export const useChatStore = create((set, get) => ({
  messages: [],        // [{ role, content, timestamp, model }]
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

  setModel: (model) => set({ model }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
  setActiveConversationId: (id) => set({ activeConversationId: id }),

  clearChat: () => set({ messages: [], streaming: false, streamingText: '' }),
}));
