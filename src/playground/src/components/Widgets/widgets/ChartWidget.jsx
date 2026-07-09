import "./ChartWidget.css";

export default function ChartWidget({ title, icon, data, config }) {
  if (!data) {
    return <div className="chart-widget-empty">No data available</div>;
  }

  // Extract mood data if available
  const moods = data.moods || data;

  if (!Array.isArray(moods) || moods.length === 0) {
    // Fallback: show key numeric values as bars
    const numericEntries = Object.entries(data)
      .filter(([, v]) => typeof v === "number")
      .slice(0, 6);

    if (numericEntries.length === 0) {
      return <div className="chart-widget-empty">No chart data</div>;
    }

    const maxVal = Math.max(...numericEntries.map(([, v]) => v), 1);

    return (
      <div className="chart-widget">
        {numericEntries.map(([key, val]) => (
          <div key={key} className="chart-bar-row">
            <span className="chart-bar-label">{key.replace(/_/g, " ")}</span>
            <div className="chart-bar-track">
              <div
                className="chart-bar-fill"
                style={{ width: `${(val / maxVal) * 100}%` }}
              />
            </div>
            <span className="chart-bar-value">{val}</span>
          </div>
        ))}
      </div>
    );
  }

  // Mood distribution
  const moodCounts = {};
  moods.forEach((m) => {
    const mood = m.mood || m.key || m.label || "unknown";
    moodCounts[mood] = (moodCounts[mood] || 0) + 1;
  });

  const entries = Object.entries(moodCounts).sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(...entries.map(([, c]) => c), 1);
  const total = entries.reduce((sum, [, c]) => sum + c, 0);

  return (
    <div className="chart-widget">
      <div className="chart-total">Total: {total}</div>
      {entries.map(([mood, count]) => (
        <div key={mood} className="chart-bar-row">
          <span className="chart-bar-label">{mood}</span>
          <div className="chart-bar-track">
            <div
              className="chart-bar-fill accent"
              style={{ width: `${(count / maxCount) * 100}%` }}
            />
          </div>
          <span className="chart-bar-value">{count}</span>
        </div>
      ))}
    </div>
  );
}
