#!/usr/bin/env bash
# Runs the spike measurement series; results (summary lines) go to results.jsonl.
cd "$(dirname "$0")"
export $(sudo grep -E "JANUS_TOKEN_SECRET|AUDIOBRIDGE_ADMIN_KEY" /etc/resumeround/secrets.env | xargs)
export BOT_RTP_IP=$(hostname -I | cut -d" " -f1)
: > results.jsonl
run() { timeout 900 npx tsx load-test.ts "$@" 2>&1 | grep "\"summary\"" >> results.jsonl; }
run a 1 15 6
run b 1 15 6
run a 1 15 2
run b 1 15 2
run a 10 8 2
run b 10 8 2
run a 25 6 2
run b 25 6 2
echo done >> results.jsonl
