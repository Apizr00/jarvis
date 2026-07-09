import { Outlet, useLocation, NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import ChatPanel from "../Chat/ChatPanel";
import { useThemeStore } from "../../stores/themeStore";
import { useAuthStore } from "../../stores/authStore";
import "./DashboardLayout.css";

const MOBILE_NAV = [
  { to: "/", icon: "🏠", label: "Home" },
  { to: "/chat", icon: "💬", label: "Chat" },
  { to: "/tasks", icon: "✅", label: "Tasks" },
  { to: "/reminders", icon: "⏰", label: "Remind" },
  { to: "/waktu-solat", icon: "🕌", label: "Solat" },
];

export default function DashboardLayout() {
  const init = useThemeStore((s) => s.init);
  const verifyToken = useAuthStore((s) => s.verifyToken);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    init();
    verifyToken();
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="dashboard-layout">
      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div
          className="mobile-overlay"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <Sidebar
        mobileOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      />
      <div className="main-area">
        <TopBar onMenuClick={() => setMobileMenuOpen(true)} />
        <main className="page-content">
          <Outlet />
        </main>
      </div>
      <ChatPanel />

      {/* Mobile bottom nav */}
      <nav className="mobile-bottom-nav">
        {MOBILE_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `mobile-nav-item ${isActive ? "active" : ""}`
            }
          >
            <span className="mobile-nav-icon">{item.icon}</span>
            <span className="mobile-nav-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
