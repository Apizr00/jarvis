import "./ListWidget.css";

export default function ListWidget({ title, icon, data }) {
  if (!data) {
    return <div className="list-widget-empty">No data available</div>;
  }

  // Handle array data
  const items = Array.isArray(data)
    ? data
    : data.items || data.facts || data.tasks || data.notes || data.moods || [];

  if (!Array.isArray(items) || items.length === 0) {
    return <div className="list-widget-empty">No items to display</div>;
  }

  return (
    <div className="list-widget">
      {items.slice(0, 10).map((item, i) => (
        <div key={i} className="list-item">
          <span className="list-item-text">
            {item.title ||
              item.key ||
              item.label ||
              item.mood ||
              item.name ||
              `Item ${i + 1}`}
          </span>
          {item.value && (
            <span className="list-item-value">
              {String(item.value).slice(0, 40)}
            </span>
          )}
          {item.count !== undefined && (
            <span className="badge badge-purple">{item.count}</span>
          )}
        </div>
      ))}
      {items.length > 10 && (
        <div className="list-footer">+{items.length - 10} more items</div>
      )}
    </div>
  );
}
