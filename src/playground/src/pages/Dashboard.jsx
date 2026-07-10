import { useEffect } from "react";
import { useWidgetStore } from "../stores/widgetStore";
import WidgetGrid from "../components/Widgets/WidgetGrid";
import "./Dashboard.css";

export default function Dashboard() {
  const { fetchWidgets, widgets, loading, error } = useWidgetStore();

  useEffect(() => {
    fetchWidgets();
    const interval = setInterval(fetchWidgets, 60000); // Refresh widget list every minute
    return () => clearInterval(interval);
  }, []);

  if (loading && widgets.length === 0) {
    return (
      <div className="dashboard-loading">
        <div className="skeleton" style={{ height: 200 }} />
        <div className="skeleton" style={{ height: 160 }} />
        <div className="skeleton" style={{ height: 140 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="state-message">
        <div className="state-icon">⚠️</div>
        <div className="state-title">Failed to load widgets</div>
        <div className="state-desc">{error}</div>
        <button
          className="btn btn-primary"
          onClick={fetchWidgets}
          style={{ marginTop: 16 }}
        >
          🔄 Retry
        </button>
      </div>
    );
  }

  if (widgets.length === 0) {
    return (
      <div className="state-message">
        <div className="state-icon">📦</div>
        <div className="state-title">No widgets yet</div>
        <div className="state-desc">
          Enable plugins in the <a href="/plugins">Plugin Manager</a> to add
          widgets to your dashboard.
        </div>
      </div>
    );
  }

  return <WidgetGrid />;
}
