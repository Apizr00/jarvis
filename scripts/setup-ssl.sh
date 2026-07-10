#!/bin/bash
# setup-ssl.sh — Obtain SSL certificate via Let's Encrypt for playground.hafizrodzli.com
# Run: sudo ./scripts/setup-ssl.sh

set -euo pipefail

DOMAIN="playground.hafizrodzli.com"
EMAIL="hafiz@hafizrodzli.com"  # CHANGE THIS to your email

echo "🔒 Setting up SSL for $DOMAIN..."

# ── 1. Install Certbot if not already installed ────────────────────────
if ! command -v certbot &> /dev/null; then
  echo "📦 Installing certbot..."
  apt-get update
  apt-get install -y certbot python3-certbot-nginx
fi

# ── 2. Obtain certificate ──────────────────────────────────────────────
echo "📜 Obtaining SSL certificate..."
certbot --nginx \
  -d "$DOMAIN" \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --redirect

# ── 3. Enable auto-renewal ─────────────────────────────────────────────
echo "🔄 Setting up auto-renewal..."
systemctl enable certbot.timer
systemctl start certbot.timer

# ── 4. Test renewal ────────────────────────────────────────────────────
echo "🧪 Testing auto-renewal..."
certbot renew --dry-run

echo ""
echo "✅ SSL configured for https://$DOMAIN"
echo "   Certificate will auto-renew via certbot timer."
