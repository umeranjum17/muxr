#!/usr/bin/env bash
set -euo pipefail
umask 077
export HOME=/home/reviewer MUXR_HOME=/home/reviewer/.muxr PATH=/home/reviewer/.local/bin:/usr/local/bin:/usr/bin:/bin
mkdir -p "$MUXR_HOME" /srv/review-workspace

if [ ! -d /srv/review-workspace/.git ]; then
  git -C /srv/review-workspace init -q
  git -C /srv/review-workspace config user.name 'Review Agent'
  git -C /srv/review-workspace config user.email 'review@localhost'
  printf 'Welcome to the synthetic muxr review workspace.\n' > /srv/review-workspace/README.md
  git -C /srv/review-workspace add README.md
  git -C /srv/review-workspace commit -qm 'Review baseline'
  git -C /srv/review-workspace tag baseline
fi

if [ ! -f "$MUXR_HOME/selfhost.json" ]; then
  MUXR_NO_SERVICE_COMMANDS=1 muxr self-host --advertise wss://review.178.104.81.27.sslip.io --port 8792 --no-pair --yes
  node --input-type=module -e "import('/opt/review/node_modules/@trymuxr/cli/setup/infrastructure/selfhostRelay.mjs').then(m=>m.stopSelfhostRelayIfRunning())"
fi

MUXR_MODE=selfhost node /opt/review/node_modules/@trymuxr/cli/setup/presentation/hostUp.mjs & host_pid=$!
for i in $(seq 1 60); do
  if [ -S "$MUXR_HOME/host/pair.sock" ]; then break; fi
  kill -0 "$host_pid" 2>/dev/null || { echo 'muxr host stopped' >&2; exit 1; }
  sleep 1
done
[ -S "$MUXR_HOME/host/pair.sock" ] || { echo 'muxr pairing socket unavailable' >&2; exit 1; }

# The container owns its own Herdr server and synthetic panes; no host Herdr state is mounted.
if ! herdr workspace list | jq -e '.result.workspaces[]? | select(.label == "Review")' >/dev/null; then
  pane="$(herdr workspace create --cwd /srv/review-workspace --label Review --no-focus | jq -r '.result.root_pane.pane_id')"
  [ -n "$pane" ] && [ "$pane" != null ] || { echo 'Herdr did not create the review pane' >&2; exit 1; }
  herdr pane run "$pane" /opt/review/review-agent.sh >/dev/null
fi

if [ ! -f "$MUXR_HOME/review-token" ]; then
  openssl rand -hex 32 > "$MUXR_HOME/review-token"
  date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ > "$MUXR_HOME/review-expiry"
fi
export REVIEW_INVITE_TOKEN_HASH="$(printf %s "$(cat "$MUXR_HOME/review-token")" | sha256sum | cut -d' ' -f1)"
export REVIEW_INVITE_EXPIRES_AT="$(cat "$MUXR_HOME/review-expiry")" REVIEW_INVITE_MAX_CLAIMS=200 PORT=8081 MUXR_BIN=/usr/local/bin/muxr
node /opt/review/invite.mjs & invite_pid=$!
nginx -c /opt/review/nginx.conf -g 'daemon off;' & nginx_pid=$!
(
  while sleep 86400; do
    git -C /srv/review-workspace reset --hard baseline >/dev/null
    git -C /srv/review-workspace clean -fd >/dev/null
  done
) & reset_pid=$!
stop() { kill "$host_pid" "$invite_pid" "$nginx_pid" "$reset_pid" 2>/dev/null || true; wait 2>/dev/null || true; }
trap stop EXIT TERM INT
wait -n "$host_pid" "$invite_pid" "$nginx_pid" "$reset_pid"
