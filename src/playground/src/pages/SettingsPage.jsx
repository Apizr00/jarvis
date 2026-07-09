import { useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { useThemeStore } from "../stores/themeStore";
import "./SettingsPage.css";

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { preference, setTheme } = useThemeStore();

  return (
    <div className="settings-page fade-in">
      <div className="settings-section card">
        <h3>👤 Profile</h3>
        <div className="setting-row">
          <label>Name</label>
          <input type="text" value={user?.firstName || ""} readOnly disabled />
        </div>
        <div className="setting-row">
          <label>Telegram ID</label>
          <input type="text" value={user?.sub || ""} readOnly disabled />
        </div>
        {user?.username && (
          <div className="setting-row">
            <label>Username</label>
            <input type="text" value={`@${user.username}`} readOnly disabled />
          </div>
        )}
      </div>

      <div className="settings-section card">
        <h3>🎨 Appearance</h3>
        <div className="setting-row">
          <label>Theme</label>
          <div className="theme-options">
            {[
              { value: "dark", icon: "🌙", label: "Dark" },
              { value: "light", icon: "☀️", label: "Light" },
              { value: "system", icon: "💻", label: "System" },
            ].map((opt) => (
              <button
                key={opt.value}
                className={`btn btn-sm ${preference === opt.value ? "btn-primary" : ""}`}
                onClick={() => setTheme(opt.value)}
              >
                {opt.icon} {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-section card">
        <h3>🤖 AI Defaults</h3>
        <div className="setting-row">
          <label>Language</label>
          <select defaultValue="auto">
            <option value="auto">Auto-detect</option>
            <option value="ms">Bahasa Melayu</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div className="settings-section card">
        <h3>📋 About</h3>
        <div className="about-info">
          <p>
            <strong>Jarvis Playground</strong> v1.0.0
          </p>
          <p>Personal AI Assistant Dashboard</p>
          <p className="about-stack">
            Built with React · Express · PostgreSQL · ILMU · DeepSeek
          </p>
        </div>
      </div>

      <div className="settings-section">
        <button className="btn btn-danger" onClick={logout}>
          🚪 Logout
        </button>
      </div>
    </div>
  );
}
