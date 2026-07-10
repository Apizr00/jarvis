import { useWidgetStore } from "../../stores/widgetStore";
import WidgetRenderer from "./WidgetRenderer";
import "./WidgetGrid.css";

export default function WidgetGrid() {
  const { widgets, layout, updateLayout } = useWidgetStore();

  if (!layout || layout.length === 0) return null;

  // Build grid items from layout
  const gridItems = layout
    .map((item) => {
      const widget = widgets.find((w) => w.widgetId === item.widgetId);
      return widget ? { ...item, widget } : null;
    })
    .filter(Boolean);

  return (
    <div className="widget-grid">
      {gridItems.map((item) => (
        <div
          key={item.widgetId}
          className="widget-cell"
          style={{
            gridColumn: `span ${item.w || 2}`,
            gridRow: `span ${item.h || 1}`,
          }}
        >
          <WidgetRenderer
            widget={item.widget}
            onRemove={() => {
              const newLayout = layout.filter(
                (l) => l.widgetId !== item.widgetId,
              );
              updateLayout(newLayout);
            }}
          />
        </div>
      ))}
    </div>
  );
}
