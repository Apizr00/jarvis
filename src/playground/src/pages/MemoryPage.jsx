import { useState, useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import "./MemoryPage.css";

export default function MemoryPage() {
  const [facts, setFacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [editingKey, setEditingKey] = useState(null);
  const [editValue, setEditValue] = useState("");
  const getAuthHeaders = useAuthStore((s) => s.getAuthHeaders);

  const fetchFacts = async () => {
    setLoading(true);
    try {
      const url = search
        ? `/api/memory/facts?search=${encodeURIComponent(search)}`
        : "/api/memory/facts";
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("Failed to fetch memory");
      const data = await res.json();
      setFacts(data.facts || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFacts();
  }, []);

  const updateFact = async (key) => {
    try {
      await fetch(`/api/memory/facts/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify({ value: editValue }),
      });
      setEditingKey(null);
      fetchFacts();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteFact = async (key) => {
    if (!confirm(`Delete fact: "${key}"?`)) return;
    try {
      await fetch(`/api/memory/facts/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      fetchFacts();
    } catch (err) {
      setError(err.message);
    }
  };

  const getConfidenceBadge = (confidence) => {
    const c = parseInt(confidence) || 50;
    if (c >= 80) return <span className="badge badge-green">🟢 {c}%</span>;
    if (c >= 50) return <span className="badge badge-yellow">🟡 {c}%</span>;
    return <span className="badge badge-red">🔴 {c}%</span>;
  };

  if (loading) {
    return (
      <div className="page-loading">
        {Array(6)
          .fill(null)
          .map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 52 }} />
          ))}
      </div>
    );
  }

  return (
    <div className="memory-page fade-in">
      <div className="memory-header">
        <h2>🧠 Memory Browser</h2>
        <div className="memory-search">
          <input
            type="text"
            placeholder="🔍 Search facts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchFacts()}
          />
          <button className="btn btn-sm btn-primary" onClick={fetchFacts}>
            Search
          </button>
        </div>
      </div>

      {error && (
        <div className="login-error" style={{ marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      <div className="memory-stats">
        <span className="badge badge-purple">{facts.length} facts</span>
      </div>

      {facts.length === 0 ? (
        <div className="state-message" style={{ marginTop: 32 }}>
          <div className="state-icon">🧠</div>
          <div className="state-title">No memories stored</div>
          <div className="state-desc">
            Memories build up as you interact with Jarvis via Telegram or chat.
          </div>
        </div>
      ) : (
        <div className="memory-table">
          <div className="memory-table-header">
            <span className="mem-col-key">Key</span>
            <span className="mem-col-value">Value</span>
            <span className="mem-col-confidence">Confidence</span>
            <span className="mem-col-actions">Actions</span>
          </div>
          {facts.map((fact) => (
            <div key={fact.key} className="memory-row">
              <span className="mem-col-key" title={fact.key}>
                {fact.key}
              </span>
              <span className="mem-col-value">
                {editingKey === fact.key ? (
                  <div className="mem-edit-inline">
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && updateFact(fact.key)
                      }
                    />
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => updateFact(fact.key)}
                    >
                      💾
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => setEditingKey(null)}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  String(fact.value || "—").slice(0, 80)
                )}
              </span>
              <span className="mem-col-confidence">
                {getConfidenceBadge(fact.confidence)}
              </span>
              <span className="mem-col-actions">
                <button
                  className="btn-icon"
                  title="Edit"
                  onClick={() => {
                    setEditingKey(fact.key);
                    setEditValue(fact.value || "");
                  }}
                >
                  ✏️
                </button>
                <button
                  className="btn-icon"
                  title="Delete"
                  onClick={() => deleteFact(fact.key)}
                >
                  🗑️
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
