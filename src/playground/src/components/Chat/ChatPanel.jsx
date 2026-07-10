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
  const [collapsed, setCollapsed] = useState(true); // always start collapsed
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
  const addToolCall = useChatStore((s) => s.addToolCall);
  const addToolResult = useChatStore((s) => s.addToolResult);
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
        case "tool_call":
          addToolCall(msg.payload.tool, msg.payload.args, msg.payload.message);
          break;
        case "tool_result":
          addToolResult(
            msg.payload.tool,
            msg.payload.content,
            msg.payload.error,
            msg.payload.buttons,
          );
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

  const handleButtonClick = (action, label) => {
    // Send button action as a chat message — LLM will interpret it
    sendMessage(`${label} (${action})`);
  };

  const cancelStream = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "cancel", payload: {} }));
    }
    setStreaming(false);
    clearStreamText();
  };

  // Auto-hide when on /chat page; otherwise user toggles via floating button
  useEffect(() => {
    if (isChatPage) setCollapsed(true);
  }, [isChatPage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Clean: fully hidden when collapsed, shown when expanded
  const panelClass = collapsed ? "chat-panel fully-hidden" : "chat-panel";

  return (
    <>
      {/* Floating chat toggle button — visible only when panel is hidden */}
      {collapsed && !isChatPage && (
        <button
          className="chat-fab"
          onClick={() => setCollapsed(false)}
          title="Buka Chat"
        >
          <span
            className={`status-dot ${wsConnected ? "ok" : "error"}`}
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              width: 7,
              height: 7,
            }}
          />
          💬
        </button>
      )}

      <aside className={panelClass}>
        <div className="chat-panel-header">
          <div className="chat-panel-title">
            <span className={`status-dot ${wsConnected ? "ok" : "error"}`} />
            <span>💬 Jarvis Chat</span>
          </div>
          <div className="chat-panel-actions">
            <ModelSelector model={model} onChange={setModel} />
            <button
              className="btn-icon"
              title="Tutup"
              onClick={() => setCollapsed(true)}
            >
              ✕
            </button>
          </div>
        </div>

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
            <MessageBubble
              key={i}
              message={msg}
              onButtonClick={handleButtonClick}
            />
          ))}
          {streaming &&
            (streamingText ? (
              <MessageBubble
                message={{
                  role: "assistant",
                  content: streamingText,
                  timestamp: new Date().toISOString(),
                }}
                isStreaming
              />
            ) : (
              <MessageBubble isTyping />
            ))}
          <div ref={messagesEndRef} />
        </div>
        <ChatInput
          onSend={sendMessage}
          onCancel={cancelStream}
          isStreaming={streaming}
          disabled={!wsConnected}
        />
      </aside>
    </>
  );
}
