import { useState, useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import "./PluginsPage.css";

export default function PluginsPage() {
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const getAuthHeaders = useAuthStore((s) => s.getAuthHeaders);

  const fetchPlugins = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/plugins", { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("Failed to fetch plugins");
      const data = await res.json();
      setPlugins(data.plugins || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlugins();
  }, []);

  const togglePlugin = async (name, enabled) => {
    setActionLoading(name);
    try {
      const res = await fetch(`/api/plugins/${name}/toggle`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("Failed to toggle plugin");
      fetchPlugins();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const reloadPlugin = async (name) => {
    setActionLoading(name);
    try {
      const res = await fetch(`/api/plugins/${name}/reload`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to reload plugin");
      fetchPlugins();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const getStateIcon = (state) => {
    switch (state) {
      case "enabled":
        return "🟢";
      case "disabled":
        return "🔴";
      case "error":
        return "❌";
      default:
        return "⏳";
    }
  };

  if (loading) {
    return (
      <div className="page-loading">
        {Array(3)
          .fill(null)
          .map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 120 }} />
          ))}
      </div>
    );
  }

  return (
    <div className="plugins-page fade-in">
      <div className="plugins-header">
        <h2>🔌 Plugin Manager</h2>
      </div>

      {error && (
        <div className="login-error" style={{ marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      {plugins.length === 0 ? (
        <div className="state-message">
          <div className="state-icon">🔌</div>
          <div className="state-title">No plugins installed</div>
          <div className="state-desc">
            Drop plugin folders into <code>src/plugins/builtin/</code> and
            they'll appear here automatically.
          </div>
        </div>
      ) : (
        <div className="plugins-list">
          {plugins.map((plugin) => (
            <div
              key={plugin.name}
              className={`plugin-card card ${plugin.state}`}
            >
              <div className="plugin-card-top">
                <div className="plugin-info">
                  <div className="plugin-name">
                    {getStateIcon(plugin.state)} {plugin.name}
                    <span className="plugin-version">v{plugin.version}</span>
                  </div>
                  <div className="plugin-desc">{plugin.description}</div>
                </div>
                <div className="plugin-toggle">
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={plugin.state === "enabled"}
                      onChange={() =>
                        togglePlugin(plugin.name, plugin.state !== "enabled")
                      }
                      disabled={actionLoading === plugin.name}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              </div>

              <div className="plugin-meta">
                {plugin.commands?.length > 0 && (
                  <div className="plugin-tags">
                    {plugin.commands.map((cmd) => (
                      <code key={cmd}>{cmd}</code>
                    ))}
                  </div>
                )}
                {plugin.widgetCount > 0 && (
                  <span className="badge badge-purple">
                    {plugin.widgetCount} widgets
                  </span>
                )}
                {plugin.pageCount > 0 && (
                  <span className="badge badge-purple">
                    {plugin.pageCount} pages
                  </span>
                )}
                <span className="plugin-author">by {plugin.author}</span>
              </div>

              <div className="plugin-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => reloadPlugin(plugin.name)}
                  disabled={actionLoading === plugin.name}
                >
                  {actionLoading === plugin.name
                    ? "⟳ Reloading..."
                    : "🔄 Reload"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
