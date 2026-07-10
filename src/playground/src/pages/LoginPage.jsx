import { useState, useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import { useNavigate } from "react-router-dom";
import "./LoginPage.css";

export default function LoginPage() {
  const {
    loginWithToken,
    loginWithTelegram,
    loginLoading,
    loginError,
    isAuthenticated,
  } = useAuthStore();
  const navigate = useNavigate();
  const [botToken, setBotToken] = useState("");
  const [botConfigured, setBotConfigured] = useState(null); // null=loading, true/false

  useEffect(() => {
    if (isAuthenticated) navigate("/", { replace: true });
  }, [isAuthenticated]);

  // ── Method 1: Token-based login ──────────────────────────────────────
  const handleTokenLogin = async (e) => {
    e.preventDefault();
    if (!botToken.trim()) return;
    await loginWithToken(botToken.trim());
  };

  // ── Method 2: Telegram Login Widget ──────────────────────────────────
  useEffect(() => {
    let cleanup = false;

    async function loadWidget() {
      try {
        const res = await fetch("/api/auth/bot-info");
        const info = await res.json();
        setBotConfigured(info.configured);
        if (!info.configured || cleanup) return;

        const script = document.createElement("script");
        script.src = "https://telegram.org/js/telegram-widget.js?22";
        script.async = true;
        script.setAttribute("data-telegram-login", info.botUsername);
        script.setAttribute("data-size", "large");
        script.setAttribute("data-radius", "10");
        script.setAttribute("data-onauth", "onTelegramAuth(user)");
        script.setAttribute("data-request-access", "write");
        document
          .getElementById("telegram-widget-container")
          ?.appendChild(script);

        window.onTelegramAuth = async (user) => {
          await loginWithTelegram(user);
        };
      } catch {}
    }

    loadWidget();
    return () => {
      cleanup = true;
      delete window.onTelegramAuth;
    };
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
          {/* ── Method 1: Token Login ──────────────────────────────── */}
          <div className="login-section">
            <h3>🔑 Login with Bot Token</h3>
            <p className="login-hint">
              Paste your Telegram bot token from @BotFather. Works immediately —
              no setup needed.
            </p>

            <form className="manual-login" onSubmit={handleTokenLogin}>
              <label>Telegram Bot Token</label>
              <input
                type="password"
                placeholder="123456:ABC-DEF1234ghikl..."
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                disabled={loginLoading}
                autoFocus
              />
              <button
                type="submit"
                className="btn btn-primary"
                style={{ marginTop: 12, width: "100%" }}
                disabled={loginLoading || !botToken.trim()}
              >
                {loginLoading ? "⟳ Verifying..." : "🔓 Login"}
              </button>
              <p className="login-note">
                Your token is verified against the server and never stored in
                the browser.
              </p>
            </form>
          </div>

          <div className="login-divider">
            <span>or</span>
          </div>

          {/* ── Method 2: Telegram OAuth Widget ────────────────────── */}
          <div className="login-section">
            <h3>📱 Telegram Login Widget</h3>
            <p className="login-hint">
              One-click login via Telegram OAuth. Requires one-time setup.
            </p>
            <div
              id="telegram-widget-container"
              className="telegram-widget-container"
            >
              {botConfigured === false && (
                <p className="login-note">
                  <strong>⚠️ Not configured yet.</strong>
                  <br />
                  Open <strong>@BotFather</strong> → <code>/setdomain</code> →{" "}
                  <code>@ApizrBot</code> →{" "}
                  <code>playground.hafizrodzli.com</code>
                  <br />
                  Then add <code>TELEGRAM_BOT_USERNAME=@ApizrBot</code> to VPS
                  .env and run <code>npm run deploy</code>.
                </p>
              )}
              {botConfigured === null && (
                <p className="login-note">Checking configuration...</p>
              )}
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
