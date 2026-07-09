import { NavLink, useLocation } from "react-router-dom";
import { useState } from "react";
import "./Sidebar.css";

const NAV_ITEMS = [
  { to: "/", icon: "🏠", label: "Dashboard" },
  { to: "/chat", icon: "💬", label: "Chat" },
  { to: "/tasks", icon: "✅", label: "Tasks" },
  { to: "/reminders", icon: "⏰", label: "Reminders" },
  { to: "/notes", icon: "📝", label: "Notes" },
  { to: "/waktu-solat", icon: "🕌", label: "Waktu Solat" },
  { to: "/memory", icon: "🧠", label: "Memory" },
  { to: "/plugins", icon: "🔌", label: "Plugins" },
  { to: "/settings", icon: "⚙️", label: "Settings" },
];

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(window.innerWidth < 768);
  const location = useLocation();

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo" onClick={() => setCollapsed(!collapsed)}>
          <span className="logo-icon">🤖</span>
          {!collapsed && <span className="logo-text">Jarvis</span>}
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
            title={collapsed ? item.label : undefined}
          >
            <span className="nav-icon">{item.icon}</span>
            {!collapsed && <span className="nav-label">{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          className="collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▶" : "◀"}
        </button>
      </div>
    </aside>
  );
}
