# Nginx configuration for playground.hafizrodzli.com
# Place in: /etc/nginx/sites-available/playground.hafizrodzli.com
# Then: sudo ln -s /etc/nginx/sites-available/playground.hafizrodzli.com /etc/nginx/sites-enabled/
# Test: sudo nginx -t
# Reload: sudo systemctl reload nginx

server {
    listen 80;
    server_name playground.hafizrodzli.com;

    # Redirect HTTP to HTTPS (after SSL is set up)
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name playground.hafizrodzli.com;

    # ── SSL (set up via Certbot) ──────────────────────────────────────────
    ssl_certificate     /etc/letsencrypt/live/playground.hafizrodzli.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/playground.hafizrodzli.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # ── Security headers ──────────────────────────────────────────────────
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # ── Gzip ──────────────────────────────────────────────────────────────
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml text/javascript image/svg+xml;
    gzip_min_length 1000;
    gzip_comp_level 6;

    # ── API proxy to Express backend ──────────────────────────────────────
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        proxy_buffering off;  # Important for streaming responses
        proxy_cache_bypass $http_upgrade;
    }

    # ── WebSocket proxy ───────────────────────────────────────────────────
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;  # 24h — keep WebSocket alive
        proxy_send_timeout 86400s;
    }

    # ── Health check (public) ─────────────────────────────────────────────
    location /health {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # ── Waktu Solat static page (legacy) ──────────────────────────────────
    location /waktu-solat {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # ── Default: return 404 for unmatched routes ──────────────────────────
    location / {
        return 404;
    }

    # ── Deny hidden files ─────────────────────────────────────────────────
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}
