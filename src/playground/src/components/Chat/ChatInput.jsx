import { useState, useRef, useEffect } from "react";
import "./ChatInput.css";

export default function ChatInput({ onSend, onCancel, isStreaming, disabled }) {
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleSubmit(e) {
    e.preventDefault();
    if (!text.trim() || isStreaming) return;
    onSend(text.trim());
    setText("");
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <form className="chat-input-bar" onSubmit={handleSubmit}>
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? "Connecting..." : "Taip mesej..."}
        rows={1}
        disabled={disabled}
        className="chat-textarea"
      />
      <div className="chat-input-actions">
        {isStreaming ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={onCancel}
          >
            ⏹ Stop
          </button>
        ) : (
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!text.trim() || disabled}
          >
            📤
          </button>
        )}
      </div>
    </form>
  );
}
