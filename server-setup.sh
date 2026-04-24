#!/bin/bash
# Run this script on the Hetzner server as root
# curl -sL https://... | bash   OR   copy-paste manually

set -e
echo "=== Setting up Telegram Bot on Hetzner ==="

# 1. Update system
apt-get update -y && apt-get upgrade -y

# 2. Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Install PM2 globally
npm install -g pm2

# 4. Create bot directory
mkdir -p /root/bot/logs
mkdir -p /root/bot/reports

echo "=== Node version: $(node --version) ==="
echo "=== NPM version: $(npm --version) ==="
echo "=== PM2 version: $(pm2 --version) ==="
echo ""
echo "✅ Server setup complete!"
echo "Now upload bot files with: bash deploy-upload.sh SERVER_IP"
