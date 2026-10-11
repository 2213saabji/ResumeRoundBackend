#!/usr/bin/env bash
# Restarts the spike bot in a room (default: prototype b, room 1001) and shows its first log lines.
#   ./restart-bot.sh [a|b] [room]
cd "$(dirname "$0")"
pkill -9 -f "run-bot.ts" 2>/dev/null
sleep 1
export $(sudo grep -E "JANUS_TOKEN_SECRET" /etc/resumeround/secrets.env | xargs)
export BOT_RTP_IP=$(hostname -I | cut -d" " -f1)
setsid nohup npx tsx run-bot.ts "${1:-b}" "${2:-1001}" > bot.log 2>&1 < /dev/null &
sleep 12
cut -c1-260 bot.log
