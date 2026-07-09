import { useState, useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import { useNavigate } from "react-router-dom";
import "./LoginPage.css";

export default function LoginPage() {
  const { loginWithTelegram, loginLoading, loginError, isAuthenticated } =
    useAuthStore();
  const navigate = useNavigate();
  const [botUsername, setBotUsername] = useState("");

  useEffect(() => {
    if (isAuthenticated) navigate("/", { replace: true });
  }, [isAuthenticated]);

  // Fetch bot username for Telegram widget
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        // The bot username would be set in env; fallback display
      })
      .catch(() => {});
  }, []);

  return (
    <div className="login-page">
      <div className="login-card card">
        <div className="login-header">
          <div className="login-logo">🤖</div>
          <h1>Jarvis Playground</h1>
          <p className="login-desc">Personal AI Assistant Dashboard</p>
        </div>

        {loginError && <div className="login-error">⚠️ {loginError}</div>}

        <div className="login-methods">
          <div className="login-section">
            <h3>🔑 Manual Login</h3>
            <p className="login-hint">
              Use the Telegram Login Widget below, or enter your Telegram bot
              token to verify. Only the configured bot owner can access this
              playground.
            </p>

            <div className="manual-login">
              <label>Telegram Bot Token</label>
              <input
                type="password"
                placeholder="Paste your bot token to login..."
                value={botUsername}
                onChange={(e) => setBotUsername(e.target.value)}
                disabled={loginLoading}
              />
              <p className="login-note">
                Your token is only used to verify your identity. It's never
                stored. Alternatively, deploy the Telegram Login Widget.
              </p>
            </div>
          </div>

          <div className="login-divider">
            <span>or</span>
          </div>

          <div className="login-section">
            <h3>📱 Telegram Login Widget</h3>
            <p className="login-hint">
              Click the button below to log in via Telegram OAuth. Requires the
              bot to be configured with a domain.
            </p>
            <div
              id="telegram-login-widget"
              className="telegram-widget-container"
            >
              <p className="login-note">
                To enable Telegram Login Widget, set your bot's domain in
                @BotFather to <code>playground.hafizrodzli.com</code> and set{" "}
                <code>TELEGRAM_BOT_USERNAME</code> in your .env file.
              </p>
            </div>
          </div>
        </div>

        <div className="login-footer">
          <p>🔒 Private — only the bot owner can log in</p>
          <p className="login-version">Jarvis Playground v1.0.0</p>
        </div>
      </div>
    </div>
  );
}
