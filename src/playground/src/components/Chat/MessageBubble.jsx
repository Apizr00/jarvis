import ReactMarkdown from "react-markdown";
import "./MessageBubble.css";

export default function MessageBubble({
  message = {},
  isStreaming,
  isTyping,
  onButtonClick,
}) {
  // Typing indicator — early return before any message access
  if (isTyping) {
    return (
      <div className="message assistant">
        <div className="message-avatar">🤖</div>
        <div className="message-body">
          <div className="message-content typing-indicator">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        </div>
      </div>
    );
  }

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
          </div>
        )}

        {/* Tool action buttons — replicate Telegram inline keyboard */}
        {!isStreaming && message.buttons && message.buttons.length > 0 && (
          <div className="message-buttons">
            {message.buttons.map((row, i) => (
              <div key={i} className="message-button-row">
                {row.map((btn, j) => (
                  <button
                    key={j}
                    className="btn btn-sm message-action-btn"
                    onClick={() => onButtonClick?.(btn.action, btn.text)}
                  >
                    {btn.text}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
