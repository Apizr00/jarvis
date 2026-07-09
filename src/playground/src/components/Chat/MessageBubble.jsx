import ReactMarkdown from "react-markdown";
import "./MessageBubble.css";

export default function MessageBubble({ message, isStreaming }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";
  const isToolResult = message.toolResult;

  const className = [
    "message",
    isUser && "user",
    isSystem && "system",
    isTool && "tool-call",
    isToolResult && "tool-result",
    !isUser && !isSystem && !isTool && !isToolResult && "assistant",
    isStreaming && "streaming",
  ]
    .filter(Boolean)
    .join(" ");

  const avatar = isUser
    ? "👤"
    : isSystem
      ? "⚠️"
      : isTool
        ? "🔧"
        : isToolResult
          ? "✅"
          : "🤖";

  // Tool call display
  if (isTool) {
    return (
      <div className={className}>
        <div className="message-avatar">{avatar}</div>
        <div className="message-body">
          <div className="message-content tool-content">
            <span className="tool-icon">🔧</span>
            <span className="tool-label">
              {message.tool?.replace(/_/g, " ") || ""}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="message-avatar">{avatar}</div>
      <div className="message-body">
        <div className="message-content">
          {isUser ? (
            <p>{message.content}</p>
          ) : (
            <ReactMarkdown>{message.content}</ReactMarkdown>
          )}
          {isStreaming && <span className="cursor-blink">▌</span>}
        </div>
        {!isStreaming && message.timestamp && (
          <div className="message-meta">
            <span className="message-time">
              {new Date(message.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {message.model && (
              <span className="badge badge-purple">{message.model}</span>
            )}
          </div>
        )}
        {!isStreaming && !isUser && !isSystem && (
          <div className="message-actions">
            <button
              className="btn-icon"
              title="Copy"
              onClick={() => navigator.clipboard.writeText(message.content)}
            >
              📋
            </button>
            <button className="btn-icon" title="Speak">
              🔊
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
