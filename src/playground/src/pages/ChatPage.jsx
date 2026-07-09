import { useState, useRef, useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import MessageBubble from "../components/Chat/MessageBubble";
import ChatInput from "../components/Chat/ChatInput";
import ModelSelector from "../components/Chat/ModelSelector";
import "./ChatPage.css";

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

export default function ChatPage() {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [model, setModel] = useState("auto");
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const token = useAuthStore((s) => s.token);

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
      setTimeout(connect, 5000);
    };
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
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
      }
    };
  }

  const sendMessage = (text) => {
    if (!text.trim() || streaming) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      connect();
      return;
    }
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, timestamp: new Date().toISOString() },
    ]);
    setStreaming(true);
    setStreamingText("");
    wsRef.current.send(
      JSON.stringify({ type: "chat", payload: { message: text, model } }),
    );
  };

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
    <div className="chat-page">
      <div className="chat-page-header">
        <div className="chat-page-status">
          <span className={`status-dot ${wsConnected ? "ok" : "error"}`} />
          <span>{wsConnected ? "Connected" : "Reconnecting..."}</span>
        </div>
        <ModelSelector model={model} onChange={setModel} />
      </div>

      <div className="chat-page-messages">
        {messages.length === 0 && !streaming && (
          <div className="chat-page-empty">
            <div className="chat-page-empty-icon">🤖</div>
            <h2>Chat dengan Jarvis</h2>
            <p>
              Tanya apa-apa sahaja. Jarvis menggunakan ILMU & DeepSeek untuk
              menjawab soalan anda.
            </p>
            <div className="chat-suggestions">
              {[
                "Apa khabar?",
                "Apa berita hari ini?",
                "Tolong ringkaskan nota saya",
                "Waktu solat Zohor pukul berapa?",
              ].map((s) => (
                <button
                  key={s}
                  className="btn btn-sm"
                  onClick={() => sendMessage(s)}
                >
                  {s}
                </button>
              ))}
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
    </div>
  );
}
