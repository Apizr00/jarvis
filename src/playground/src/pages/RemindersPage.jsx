import { useState, useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import "./RemindersPage.css";

export default function RemindersPage() {
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ text: "", remindAt: "", recurrence: "" });
  const getAuthHeaders = useAuthStore((s) => s.getAuthHeaders);

  const fetchReminders = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/reminders", { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setReminders(data.reminders || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReminders();
  }, []);

  const addReminder = async (e) => {
    e.preventDefault();
    if (!form.text || !form.remindAt) return;
    try {
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          text: form.text,
          remindAt: form.remindAt,
          recurrence: form.recurrence || null,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      setForm({ text: "", remindAt: "", recurrence: "" });
      setShowAdd(false);
      fetchReminders();
    } catch (err) {
      setError(err.message);
    }
  };

  const cancelReminder = async (id) => {
    try {
      await fetch(`/api/reminders/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      fetchReminders();
    } catch (err) {
      setError(err.message);
    }
  };

  const formatDate = (d) => {
    try {
      return new Date(d).toLocaleString("en-MY", {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return d;
    }
  };

  if (loading) {
    return (
      <div className="page-loading">
        {Array(4)
          .fill(null)
          .map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 60 }} />
          ))}
      </div>
    );
  }

  return (
    <div className="reminders-page fade-in">
      <div className="reminders-header">
        <h2>⏰ Reminders</h2>
        <button
          className="btn btn-primary"
          onClick={() => setShowAdd(!showAdd)}
        >
          {showAdd ? "✕ Cancel" : "+ New Reminder"}
        </button>
      </div>

      {error && (
        <div className="login-error" style={{ marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      {showAdd && (
        <form className="reminder-form card" onSubmit={addReminder}>
          <input
            type="text"
            placeholder="What to remind about..."
            value={form.text}
            onChange={(e) => setForm({ ...form, text: e.target.value })}
            required
          />
          <div className="reminder-form-row">
            <input
              type="datetime-local"
              value={form.remindAt}
              onChange={(e) => setForm({ ...form, remindAt: e.target.value })}
              required
            />
            <select
              value={form.recurrence}
              onChange={(e) => setForm({ ...form, recurrence: e.target.value })}
            >
              <option value="">No repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="weekdays">Weekdays</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary">
            💾 Save Reminder
          </button>
        </form>
      )}

      <div className="reminders-list">
        {reminders.length === 0 ? (
          <div className="state-message">
            <div className="state-icon">⏰</div>
            <div className="state-title">No reminders</div>
            <div className="state-desc">
              No upcoming reminders. Create one or ask Jarvis in chat: "set
              reminder..."
            </div>
          </div>
        ) : (
          reminders.map((r) => (
            <div
              key={r.id}
              className={`reminder-card card ${r.status === "sent" ? "done" : ""}`}
            >
              <div className="reminder-info">
                <div className="reminder-text">{r.text}</div>
                <div className="reminder-meta">
                  <span>📅 {formatDate(r.remind_at)}</span>
                  {r.recurrence && (
                    <span className="badge badge-purple">
                      🔁 {r.recurrence}
                    </span>
                  )}
                  {r.status === "sent" && (
                    <span className="badge badge-green">✅ Sent</span>
                  )}
                </div>
              </div>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => cancelReminder(r.id)}
              >
                🗑️
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
