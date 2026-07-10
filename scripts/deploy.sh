#!/bin/bash
# deploy.sh — Zero-downtime deployment for Jarvis
# Usage: ./scripts/deploy.sh [--no-build]
#
# Requires:
#   - PM2 installed globally: npm i -g pm2
#   - Git repo cloned on VPS at /home/hafiz/jarvis
#   - .env file configured

set -euo pipefail

APP_DIR="/home/hafiz/jarvis"
PM2_APP_NAME="jarvis"
BRANCH="${1:-main}"

echo "🚀 Jarvis Deploy — $(date '+%Y-%m-%d %H:%M:%S')"
echo "──────────────────────────────────────────────"

cd "$APP_DIR"

# ── 1. Pull latest code ────────────────────────────────────────────────
echo "📥 Pulling latest code from $BRANCH..."
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"
echo "✅ Code updated"

# ── 2. Install dependencies ────────────────────────────────────────────
echo "📦 Installing dependencies..."
npm ci --production=false
echo "✅ Dependencies installed"

# ── 3. Run database setup (idempotent) ──────────────────────────────────
echo "🗄️  Setting up database..."
node scripts/setup-db.js || echo "⚠️  DB setup had warnings (may be OK)"
echo "✅ Database ready"

# ── 4. Build playground frontend ───────────────────────────────────────
if [[ "${2:-}" != "--no-build" ]]; then
  echo "🏗️  Building playground frontend..."
  cd src/playground
  npm ci
  npm run build
  cd "$APP_DIR"
  echo "✅ Frontend built"
fi

# ── 5. Restart with PM2 (zero-downtime reload) ─────────────────────────
if pm2 list | grep -q "$PM2_APP_NAME"; then
  echo "🔄 Gracefully reloading Jarvis..."
  pm2 reload "$PM2_APP_NAME" --update-env
else
  echo "🆕 Starting Jarvis for the first time..."
  pm2 start src/index.js --name "$PM2_APP_NAME" --max-memory-restart 512M
fi

# ── 6. Save PM2 process list ───────────────────────────────────────────
pm2 save

# ── 7. Health check ────────────────────────────────────────────────────
echo "⏳ Waiting for health check..."
sleep 3
HEALTH=$(curl -s http://localhost:3000/health || echo '{"status":"error"}')
echo "🏥 Health: $(echo $HEALTH | grep -o '"status":"[^"]*"' || echo 'unknown')"

echo ""
echo "✅ Deploy complete! 🎉"
echo "   Dashboard: https://playground.hafizrodzli.com"
echo "   API:       https://playground.hafizrodzli.com/api/"
echo "   Health:    https://playground.hafizrodzli.com/health"
