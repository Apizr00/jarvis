import { useState, useEffect } from "react";
import { useAuthStore } from "../../stores/authStore";
import CardWidget from "./widgets/CardWidget";
import ListWidget from "./widgets/ListWidget";
import ChartWidget from "./widgets/ChartWidget";
import "./WidgetRenderer.css";

export default function WidgetRenderer({ widget, onRemove }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const getAuthHeaders = useAuthStore((s) => s.getAuthHeaders);

  // Fetch widget data from its endpoint
  useEffect(() => {
    if (!widget?.endpoint) return;

    let cancelled = false;
    setLoading(true);

    fetch(widget.endpoint, { headers: getAuthHeaders() })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    // Auto-refresh
    const interval =
      widget.refreshInterval > 0
        ? setInterval(() => {
            fetch(widget.endpoint, { headers: getAuthHeaders() })
              .then((r) => r.json())
              .then((d) => {
                if (!cancelled) {
                  setData(d);
                  setError(null);
                }
              })
              .catch((err) => {
                if (!cancelled) setError(err.message);
              });
          }, widget.refreshInterval)
        : null;

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [widget?.endpoint, widget?.refreshInterval]);

  const widgetProps = {
    title: widget.title,
    icon: widget.icon,
    data,
    loading,
    error,
    config: widget.config || {},
  };

  return (
    <div className={`widget-card card ${widget.type}`}>
      <div className="widget-header">
        <div className="widget-title">
          <span className="widget-icon">{widget.icon}</span>
          <span>{widget.title}</span>
        </div>
        <div className="widget-actions">
          {loading && <span className="widget-loading-indicator">⟳</span>}
          {error && <span className="status-dot error" title={error} />}
          <button className="btn-icon" title="Remove widget" onClick={onRemove}>
            ✕
          </button>
        </div>
      </div>

      <div className="widget-body">
        {loading && !data && (
          <div className="skeleton" style={{ height: "100%", minHeight: 80 }} />
        )}
        {error && !data && <div className="widget-error">⚠️ {error}</div>}
        {!loading && !error && (
          <>
            {widget.type === "card" && <CardWidget {...widgetProps} />}
            {widget.type === "list" && <ListWidget {...widgetProps} />}
            {widget.type === "chart" && <ChartWidget {...widgetProps} />}
            {!["card", "list", "chart"].includes(widget.type) && (
              <CardWidget {...widgetProps} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
