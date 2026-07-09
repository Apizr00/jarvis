import { useLocation } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useThemeStore } from "../../stores/themeStore";
import "./TopBar.css";

const PAGE_TITLES = {
  "/": "Dashboard",
  "/chat": "AI Chat",
  "/tasks": "Tasks",
  "/notes": "Notes",
  "/memory": "Memory Browser",
  "/plugins": "Plugin Manager",
  "/settings": "Settings",
  "/waktu-solat": "Waktu Solat",
};

export default function TopBar() {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { resolved: theme, toggle } = useThemeStore();

  const title = PAGE_TITLES[location.pathname] || "Jarvis Playground";

  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="page-title">{title}</h1>
      </div>

      <div className="topbar-right">
        <button
          className="btn-icon"
          onClick={toggle}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>

        <div className="user-menu">
          <div className="user-avatar">
            {user?.photoUrl ? (
              <img src={user.photoUrl} alt="" className="avatar-img" />
            ) : (
              <span className="avatar-placeholder">
                {user?.firstName?.[0] || "?"}
              </span>
            )}
          </div>
          <span className="user-name">{user?.firstName || "User"}</span>
          <button className="btn-icon" onClick={logout} title="Logout">
            🚪
          </button>
        </div>
      </div>
    </header>
  );
}
