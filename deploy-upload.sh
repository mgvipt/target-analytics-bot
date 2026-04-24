#!/bin/bash
# Usage: bash deploy-upload.sh <SERVER_IP>
# Uploads bot files to Hetzner and starts with PM2

SERVER_IP="${1:?Usage: bash deploy-upload.sh <SERVER_IP>}"
SSH_KEY="$HOME/.ssh/hetzner_key"
REMOTE="root@${SERVER_IP}"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Deploying to ${SERVER_IP} ==="

# ── 1. Upload source files ────────────────────────────────────
echo "Uploading files..."
scp -i "$SSH_KEY" \
    "$LOCAL_DIR/package.json" \
    "$LOCAL_DIR/package-lock.json" \
    "$LOCAL_DIR/ecosystem.config.cjs" \
    "${REMOTE}:/root/bot/"

# Upload reports directory (only .js and .mjs files)
scp -i "$SSH_KEY" "$LOCAL_DIR/reports/"*.js "$LOCAL_DIR/reports/"*.mjs \
    "${REMOTE}:/root/bot/reports/" 2>/dev/null || true

# ── 2. Upload secrets (NOT in git) ───────────────────────────
echo "Uploading secrets..."
scp -i "$SSH_KEY" \
    "$LOCAL_DIR/.env" \
    "$LOCAL_DIR/sheets-token.json" \
    "${REMOTE}:/root/bot/"

# drive-token.json if exists
[ -f "$LOCAL_DIR/drive-token.json" ] && \
    scp -i "$SSH_KEY" "$LOCAL_DIR/drive-token.json" "${REMOTE}:/root/bot/"

# ── 3. Install dependencies & start ──────────────────────────
echo "Installing dependencies and starting bot..."
ssh -i "$SSH_KEY" "$REMOTE" << 'ENDSSH'
  cd /root/bot
  npm install --omit=dev
  mkdir -p logs

  # Stop old instance if running
  pm2 delete tg-bot 2>/dev/null || true

  # Start with PM2
  pm2 start ecosystem.config.cjs

  # Save PM2 config so it survives reboots
  pm2 save

  # Enable PM2 to start on system boot
  pm2 startup systemd -u root --hp /root | tail -1 | bash

  echo ""
  pm2 status
ENDSSH

echo ""
echo "✅ Bot deployed and running on ${SERVER_IP}!"
echo "Logs: ssh -i ~/.ssh/hetzner_key root@${SERVER_IP} 'pm2 logs tg-bot --lines 30'"
