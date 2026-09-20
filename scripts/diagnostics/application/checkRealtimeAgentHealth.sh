#!/usr/bin/env bash
# One guarded warmed-agent parity proof for the Realtime voice path.
#
# Owns its own isolated Herdr lab session through the guarded helper, starts one
# real agent, waits until it is genuinely settled, captures direct Herdr CLI
# ground truth for its public name, status and unique output marker, then
# requires the real Realtime path (real relay + real host + real coordinator +
# real provider-facing tool runtime) to agree with that ground truth and to send
# exactly one prompt.
#
# The native speech-to-speech journey is a separate device gate and is never
# claimed here.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)
cd "$ROOT"

HERDR_LAB_HELPER=${HERDR_LAB_HELPER:-/home/umer/firstmate/bin/fm-herdr-lab.sh}
export HERDR_LAB_HELPER
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name pock-realtime-parity)
export HERDR_LAB_SESSION

# The command the pane runs. It must be an agent kind Herdr detects and it must
# be authenticated for the model it names; nothing here invents a credential.
: "${MUXR_PARITY_AGENT_COMMAND:=pi}"

EVIDENCE_DIR=${MUXR_PARITY_EVIDENCE:-"$ROOT/.realtime-parity"}
mkdir -p "$EVIDENCE_DIR/evidence"
MUXR_PARITY_EVIDENCE="$EVIDENCE_DIR/evidence"
export MUXR_PARITY_EVIDENCE
WORKDIR=$(mktemp -d "$EVIDENCE_DIR/work.XXXXXX")

# Every non-lifecycle Herdr call goes through the helper. Its fleet-state
# tripwire fails teardown closed if the default session changed.
trap '"$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || exit 1' EXIT
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
h() { "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "$@"; }

# --- warm one real agent ---------------------------------------------------
ROOT_PANE=$(h workspace create --cwd "$WORKDIR" --label realtime-parity | jq -r '.result.root_pane.pane_id')
if [ "$ROOT_PANE" = "null" ] || [ -z "$ROOT_PANE" ]; then
  ROOT_PANE=$(h pane list | jq -r '.result.panes[0].pane_id')
fi
h pane send-text "$ROOT_PANE" "$MUXR_PARITY_AGENT_COMMAND" >/dev/null
h pane send-keys "$ROOT_PANE" Enter >/dev/null

AGENT_NAME=
for _ in $(seq 1 90); do
  AGENT_NAME=$(h agent list | jq -r --arg pane "$ROOT_PANE" '.result.agents[]? | select(.pane_id == $pane) | .name // empty' | head -n 1)
  [ -n "$AGENT_NAME" ] && break
  sleep 2
done
[ -n "$AGENT_NAME" ] || { echo "FAIL: no agent was detected in $ROOT_PANE" >&2; exit 1; }
MUXR_PARITY_AGENT=${MUXR_PARITY_AGENT:-parity1}
export MUXR_PARITY_AGENT
h agent rename "$AGENT_NAME" "$MUXR_PARITY_AGENT" >/dev/null
echo "ok: $MUXR_PARITY_AGENT is running in the isolated lab session"

# Genuine settle. Herdr grants readiness about three seconds in and the agent
# reports idle from its first state hook, both well before a full-config agent
# has consumed its first input. Warm it against the wall clock and against
# stability instead: a long, uninterrupted idle run with the pane really drawn.
settled=0
for _ in $(seq 1 90); do
  STATUS=$(h agent get "$MUXR_PARITY_AGENT" | jq -r '.result.agent.agent_status // "unknown"')
  if [ "$STATUS" = "idle" ]; then
    settled=$((settled + 1))
    [ "$settled" -ge 10 ] && break
  else
    settled=0
  fi
  sleep 2
done
[ "$settled" -ge 10 ] || { echo "FAIL: $MUXR_PARITY_AGENT never reached a stable idle state" >&2; exit 1; }
sleep "${MUXR_PARITY_WARM_SETTLE_SECONDS:-20}"
h pane read "$ROOT_PANE" --source visible --format text > "$EVIDENCE_DIR/herdr-pane.txt"
[ -s "$EVIDENCE_DIR/herdr-pane.txt" ] || { echo "FAIL: $MUXR_PARITY_AGENT never drew its pane" >&2; exit 1; }
echo "ok: $MUXR_PARITY_AGENT settled (stable idle, pane drawn)"

# --- direct Herdr ground truth --------------------------------------------
MUXR_PARITY_MARKER="WARMGROUND_$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
export MUXR_PARITY_MARKER
h agent prompt "$MUXR_PARITY_AGENT" \
  "Reply with exactly this line and nothing else, then stop: $MUXR_PARITY_MARKER" \
  --wait --timeout 120000 > "$EVIDENCE_DIR/herdr-warm.json"
h agent get "$MUXR_PARITY_AGENT" > "$EVIDENCE_DIR/herdr-agent.json"
h agent read "$MUXR_PARITY_AGENT" --source recent-unwrapped --lines 300 --format text > "$EVIDENCE_DIR/herdr-read.txt"
grep -q "$MUXR_PARITY_MARKER" "$EVIDENCE_DIR/herdr-read.txt" || {
  echo "FAIL: direct Herdr never returned $MUXR_PARITY_MARKER" >&2
  exit 1
}
echo "ok: direct Herdr ground truth captured for $MUXR_PARITY_AGENT"

node scripts/diagnostics/application/checkRealtimeParity.mjs
echo "PARITY: the real Realtime path agrees with direct Herdr and sent exactly one prompt"
echo "NATIVE S2S: not covered by this gate; it requires the device journey runner"
