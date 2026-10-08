#!/usr/bin/env bash
# Sets up (or updates) the ResumeRound dev media server: Janus + coturn + Node.js 22.
# Idempotent: safe to run again after changing any config in this folder.
#
#   scp -r infra/dev-server ubuntu@<server>:~/
#   ssh ubuntu@<server> 'sudo bash ~/dev-server/setup.sh'
#
# Secrets are generated once into /etc/resumeround/secrets.env (root-only) and reused.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SECRETS_FILE=/etc/resumeround/secrets.env
TURN_REALM_DEFAULT=resumeround.dev

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0" >&2
  exit 1
fi

log() { printf '\n==> %s\n' "$*"; }

imds() {
  local token
  token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
  curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}

log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq janus coturn gettext-base curl ca-certificates openssl >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  log "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

log "Secrets"
if [[ ! -f $SECRETS_FILE ]]; then
  install -d -m 700 /etc/resumeround
  umask 077
  cat >"$SECRETS_FILE" <<EOF
JANUS_TOKEN_SECRET=$(openssl rand -hex 32)
JANUS_ADMIN_SECRET=$(openssl rand -hex 32)
AUDIOBRIDGE_ADMIN_KEY=$(openssl rand -hex 24)
TEXTROOM_ADMIN_KEY=$(openssl rand -hex 24)
VIDEOROOM_ADMIN_KEY=$(openssl rand -hex 24)
SPIKE_ROOM_SECRET=$(openssl rand -hex 16)
TURN_SECRET=$(openssl rand -hex 32)
TURN_REALM=$TURN_REALM_DEFAULT
EOF
  echo "Generated $SECRETS_FILE"
else
  echo "Reusing $SECRETS_FILE"
fi
set -a
# shellcheck disable=SC1090
source "$SECRETS_FILE"
set +a

PUBLIC_IP=$(imds public-ipv4)
PRIVATE_IP=$(imds local-ipv4)
export PUBLIC_IP PRIVATE_IP
echo "Public IP: $PUBLIC_IP  Private IP: $PRIVATE_IP"

# Only these variables are substituted, so any other '$' in the configs is left alone.
VARS='${PUBLIC_IP} ${PRIVATE_IP} ${JANUS_TOKEN_SECRET} ${JANUS_ADMIN_SECRET} ${AUDIOBRIDGE_ADMIN_KEY} ${TEXTROOM_ADMIN_KEY} ${VIDEOROOM_ADMIN_KEY} ${SPIKE_ROOM_SECRET} ${TURN_SECRET} ${TURN_REALM}'

render() { # render <template> <destination> <owner:group>
  local tmp
  tmp=$(mktemp)
  envsubst "$VARS" <"$1" >"$tmp"
  install -m 640 -o "${3%%:*}" -g "${3##*:}" "$tmp" "$2"
  rm -f "$tmp"
}

log "Janus configuration"
JANUS_GROUP=$(systemctl show -p Group --value janus 2>/dev/null || true)
JANUS_GROUP=${JANUS_GROUP:-root}
for f in "$HERE"/janus/*.jcfg; do
  render "$f" "/etc/janus/$(basename "$f")" "root:$JANUS_GROUP"
done

log "coturn configuration"
TURN_GROUP=$(systemctl show -p Group --value coturn 2>/dev/null || true)
TURN_GROUP=${TURN_GROUP:-root}
render "$HERE/coturn/turnserver.conf" /etc/turnserver.conf "root:$TURN_GROUP"
if [[ -f /etc/default/coturn ]]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
fi

log "Restarting services"
systemctl enable janus coturn >/dev/null 2>&1
systemctl restart janus coturn
sleep 3

log "Verification"
systemctl is-active janus coturn
ss -lntup | grep -E ':(8088|8188|7088|3478)\b' || true
echo
curl -fsS http://127.0.0.1:8088/janus/info | head -c 300 && echo
echo "node $(node -v)"
