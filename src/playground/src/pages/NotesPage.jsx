import { useState, useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import "./NotesPage.css";

export default function NotesPage() {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showEditor, setShowEditor] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const getAuthHeaders = useAuthStore((s) => s.getAuthHeaders);

  const fetchNotes = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notes", { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("Failed to fetch notes");
      const data = await res.json();
      setNotes(data.notes || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotes();
  }, []);

  const saveNote = async (e) => {
    e.preventDefault();
    if (!content.trim() && !title.trim()) return;
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ title: title || undefined, content }),
      });
      if (!res.ok) throw new Error("Failed to save note");
      setTitle("");
      setContent("");
      setShowEditor(false);
      fetchNotes();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteNote = async (id) => {
    try {
      await fetch(`/api/notes/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      fetchNotes();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="page-loading">
        {Array(4)
          .fill(null)
          .map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 80 }} />
          ))}
      </div>
    );
  }

  return (
    <div className="notes-page fade-in">
      <div className="notes-header">
        <h2>📝 Notes</h2>
        <button
          className="btn btn-primary"
          onClick={() => setShowEditor(!showEditor)}
        >
          {showEditor ? "✕ Cancel" : "+ New Note"}
        </button>
      </div>

      {error && (
        <div className="login-error" style={{ marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      {showEditor && (
        <form className="note-editor card" onSubmit={saveNote}>
          <input
            type="text"
            placeholder="Note title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="note-title-input"
          />
          <textarea
            placeholder="Write your note..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            className="note-content-input"
          />
          <div className="note-editor-actions">
            <button type="submit" className="btn btn-primary">
              💾 Save Note
            </button>
          </div>
        </form>
      )}

      <div className="notes-grid">
        {notes.length === 0 && !showEditor ? (
          <div className="state-message">
            <div className="state-icon">📝</div>
            <div className="state-title">No notes yet</div>
            <div className="state-desc">
              Create your first note to get started.
            </div>
          </div>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="note-card card">
              <div className="note-card-content">
                {note.content.startsWith("# ") ? (
                  <>
                    <h3 className="note-card-title">
                      {note.content.split("\n")[0].replace("# ", "")}
                    </h3>
                    <p className="note-card-body">
                      {note.content.split("\n").slice(1).join("\n").trim()}
                    </p>
                  </>
                ) : (
                  <p className="note-card-body">{note.content}</p>
                )}
              </div>
              <div className="note-card-footer">
                <span className="note-card-date">
                  {new Date(note.created_at).toLocaleDateString("en-MY", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
                <button
                  className="btn-icon"
                  title="Delete"
                  onClick={() => deleteNote(note.id)}
                >
                  🗑️
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
