import "./CardWidget.css";

export default function CardWidget({ title, icon, data, config }) {
  // Generic card renderer — displays key data points
  if (!data) {
    return <div className="card-widget-empty">No data available</div>;
  }

  // Try to display common prayer times data shape
  if (data.timings) {
    const OBLIGATORY = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
    const LABELS = {
      fajr: "Subuh",
      dhuhr: "Zohor",
      asr: "Asar",
      maghrib: "Maghrib",
      isha: "Isyak",
    };

    return (
      <div className="card-widget">
        {data.hijri && <div className="prayer-hijri">{data.hijri}H</div>}
        <div className="prayer-times-list">
          {OBLIGATORY.map((key) => {
            const time = data.timings[key];
            if (!time) return null;
            const [h, m] = time.split(":");
            const date = new Date();
            date.setHours(parseInt(h), parseInt(m), 0);
            const time12h = date.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });
            return (
              <div key={key} className="prayer-row">
                <span className="prayer-label">{LABELS[key]}</span>
                <span className="prayer-time">{time12h}</span>
              </div>
            );
          })}
        </div>
        {data.metadata?.serverTime && (
          <div className="widget-footer-text">
            🟢 Live ·{" "}
            {new Date(data.metadata.serverTime).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>
    );
  }

  // Weekly summary data shape
  if (data.weekStart && data.weekEnd) {
    const start = new Date(data.weekStart).toLocaleDateString("en-MY", {
      day: "numeric",
      month: "short",
    });
    const end = new Date(data.weekEnd).toLocaleDateString("en-MY", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    return (
      <div className="card-widget">
        <div className="weekly-period">
          {start} – {end}
        </div>
        <div className="card-row">
          <span className="card-label">Messages</span>
          <span className="card-value">
            {data.messageCount ?? data.totalMessages ?? 0}
          </span>
        </div>
        {data.totalMoods !== undefined && (
          <div className="card-row">
            <span className="card-label">Moods tracked</span>
            <span className="card-value">{data.totalMoods}</span>
          </div>
        )}
        {data.totalMessages > 0 ? (
          <div className="widget-footer-text">
            🟢 Keep chatting with Jarvis!
          </div>
        ) : (
          <div className="widget-footer-text">
            💬 Start chatting to see stats.
          </div>
        )}
      </div>
    );
  }

  // Generic: render key/value pairs
  const entries = Object.entries(data).filter(([k]) => !k.startsWith("_"));
  return (
    <div className="card-widget">
      {entries.slice(0, 8).map(([key, val]) => (
        <div key={key} className="card-row">
          <span className="card-label">{key.replace(/_/g, " ")}</span>
          <span className="card-value">
            {typeof val === "object"
              ? JSON.stringify(val).slice(0, 60)
              : String(val)}
          </span>
        </div>
      ))}
      {entries.length > 8 && (
        <div className="widget-footer-text">+{entries.length - 8} more</div>
      )}
    </div>
  );
}
