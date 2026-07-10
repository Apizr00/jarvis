import { create } from 'zustand';

const LAYOUT_KEY = 'jarvis-widget-layout';

function loadLayout() {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function saveLayout(layout) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

export const useWidgetStore = create((set, get) => ({
  widgets: [],       // Available widgets from server
  layout: loadLayout(), // User's layout config [{widgetId, x, y, w, h}]
  loading: false,
  error: null,

  fetchWidgets: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/widgets');
      if (!res.ok) throw new Error('Failed to fetch widgets');
      const data = await res.json();
      set({ widgets: data.widgets || [], loading: false });

      // Auto-add new widgets to layout
      const layout = get().layout;
      const layoutIds = new Set(layout.map(l => l.widgetId));
      const newWidgets = (data.widgets || []).filter(w => !layoutIds.has(w.widgetId));
      if (newWidgets.length > 0) {
        const updatedLayout = [...layout];
        newWidgets.forEach((w, i) => {
          updatedLayout.push({
            widgetId: w.widgetId,
            x: (i * 2) % 4,
            y: Math.floor(layout.length / 2) + (i * 2),
            w: w.defaultSize?.w || 2,
            h: w.defaultSize?.h || 1,
          });
        });
        set({ layout: updatedLayout });
        saveLayout(updatedLayout);
      }
    } catch (err) {
      set({ loading: false, error: err.message });
    }
  },

  updateLayout: (newLayout) => {
    set({ layout: newLayout });
    saveLayout(newLayout);
  },

  removeWidget: (widgetId) => {
    const layout = get().layout.filter(l => l.widgetId !== widgetId);
    set({ layout });
    saveLayout(layout);
  },
}));
