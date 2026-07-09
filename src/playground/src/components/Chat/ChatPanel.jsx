import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useChatStore } from "../../stores/chatStore";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";
import ModelSelector from "./ModelSelector";
import "./ChatPanel.css";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

export default function ChatPanel() {
  const location = useLocation();
  const isChatPage = location.pathname === "/chat";
  const [collapsed, setCollapsed] = useState(window.innerWidth < 768);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const token = useAuthStore((s) => s.token);

  // Use shared store — survives tab switches
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const streamingText = useChatStore((s) => s.streamingText);
  const model = useChatStore((s) => s.model);
  const wsConnected = useChatStore((s) => s.wsConnected);
  const addMessage = useChatStore((s) => s.addMessage);
  const appendStreamText = useChatStore((s) => s.appendStreamText);
  const finalizeStream = useChatStore((s) => s.finalizeStream);
  const setStreaming = useChatStore((s) => s.setStreaming);
  const clearStreamText = useChatStore((s) => s.clearStreamText);
  const setModel = useChatStore((s) => s.setModel);
  const setWsConnected = useChatStore((s) => s.setWsConnected);

  // Connect WebSocket — shared across both ChatPanel and ChatPage
  useEffect(() => {
    if (!token) return;
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [token]);

  // Auto-collapse sidebar when on full Chat page (both show same conversation)
  useEffect(() => {
    if (isChatPage) setCollapsed(true);
  }, [isChatPage]);

  function connect() {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => {
      setWsConnected(false);
      setTimeout(connect, 5000);
    };
    ws.onerror = () => setWsConnected(false);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "chunk":
          appendStreamText(msg.payload.text);
          break;
        case "done":
          finalizeStream(msg.payload.fullText, msg.payload.metadata || {});
          break;
        case "error":
          addMessage({
            role: "system",
            content: `Error: ${msg.payload.message}`,
            timestamp: new Date().toISOString(),
          });
          clearStreamText();
          setStreaming(false);
          break;
      }
    };
  }

  const sendMessage = useCallback(
    (text) => {
      if (!text.trim() || streaming) return;
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connect();
        return;
      }
      addMessage({
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      });
      setStreaming(true);
      clearStreamText();
      wsRef.current.send(
        JSON.stringify({ type: "chat", payload: { message: text, model } }),
      );
    },
    [streaming, model],
  );

  const cancelStream = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "cancel", payload: {} }));
    }
    setStreaming(false);
    clearStreamText();
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Determine panel class
  const panelClass = isChatPage
    ? "chat-panel fully-hidden"
    : collapsed
      ? "chat-panel collapsed"
      : "chat-panel";

  return (
    <aside className={panelClass}>
      <div
        className="chat-panel-header"
        onClick={() => { if (!isChatPage) setCollapsed(!collapsed); }}
      >
        <div className="chat-panel-title">
          <span className={`status-dot ${wsConnected ? "ok" : "error"}`} />
          <span>💬 Jarvis Chat</span>
        </div>
        {!isChatPage && (
          <div className="chat-panel-actions">
            <ModelSelector model={model} onChange={setModel} />
            <button className="btn-icon" title={collapsed ? "Expand" : "Collapse"}>
              {collapsed ? "◀" : "▶"}
            </button>
          </div>
        )}
      </div>

      {!collapsed && !isChatPage && (
        <>
          <div className="chat-messages">
            {messages.length === 0 && !streaming && (
              <div className="chat-empty">
                <div className="chat-empty-icon">🤖</div>
                <div className="chat-empty-title">Bual dengan Jarvis</div>
                <div className="chat-empty-desc">
                  Tanya apa-apa — Jarvis guna ILMU & DeepSeek untuk jawab.
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}
            {streaming && (
              <MessageBubble
                message={{
                  role: "assistant",
                  content: streamingText,
                  timestamp: new Date().toISOString(),
                }}
                isStreaming
              />
            )}
            <div ref={messagesEndRef} />
          </div>
          <ChatInput
            onSend={sendMessage}
            onCancel={cancelStream}
            isStreaming={streaming}
            disabled={!wsConnected}
          />
        </>
      )}
    </aside>
  );
}
