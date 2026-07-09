import { useState, useRef, useEffect, useCallback } from "react";
import { useAuthStore } from "../../stores/authStore";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";
import ModelSelector from "./ModelSelector";
import "./ChatPanel.css";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

export default function ChatPanel() {
  const [collapsed, setCollapsed] = useState(window.innerWidth < 768);
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [model, setModel] = useState("auto");
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const token = useAuthStore((s) => s.token);

  // Connect WebSocket
  useEffect(() => {
    if (!token) return;
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [token]);

  function connect() {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => {
      setWsConnected(false);
      setTimeout(connect, 5000); // Reconnect after 5s
    };
    ws.onerror = () => setWsConnected(false);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "connected":
          break;
        case "chunk":
          setStreamingText((prev) => prev + msg.payload.text);
          break;
        case "done":
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: msg.payload.fullText,
              timestamp: new Date().toISOString(),
              model: msg.payload.metadata?.model,
            },
          ]);
          setStreamingText("");
          setStreaming(false);
          break;
        case "error":
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              content: `Error: ${msg.payload.message}`,
              timestamp: new Date().toISOString(),
            },
          ]);
          setStreamingText("");
          setStreaming(false);
          break;
        case "typing":
          break;
        case "event":
          break;
        case "pong":
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

      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          content: text,
          timestamp: new Date().toISOString(),
        },
      ]);
      setStreaming(true);
      setStreamingText("");

      wsRef.current.send(
        JSON.stringify({
          type: "chat",
          payload: { message: text, model },
        }),
      );
    },
    [streaming, model],
  );

  const cancelStream = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "cancel", payload: {} }));
    }
    setStreaming(false);
    setStreamingText("");
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  return (
    <aside className={`chat-panel ${collapsed ? "collapsed" : ""}`}>
      <div
        className="chat-panel-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="chat-panel-title">
          <span className={`status-dot ${wsConnected ? "ok" : "error"}`} />
          <span>💬 Jarvis Chat</span>
        </div>
        <div className="chat-panel-actions">
          <ModelSelector model={model} onChange={setModel} />
          <button
            className="btn-icon"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "◀" : "▶"}
          </button>
        </div>
      </div>

      {!collapsed && (
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
