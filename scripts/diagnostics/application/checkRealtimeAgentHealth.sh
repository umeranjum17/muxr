#!/usr/bin/env bash
# Guarded product voice attachment check with a warmed Herdr agent.
#
# Owns its isolated Herdr lab session through the guarded helper and checks
# product voice attachment over a real relay and host. Native speech-to-speech
# is a separate device gate and is never claimed here.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)
cd "$ROOT"

if [ -z "${HERDR_LAB_HELPER:-}" ]; then
  echo "SKIP: HERDR_LAB_HELPER is unset; set it to the guarded herdr lab helper to run this parity check." >&2
  exit 2
fi
if [ ! -e "$HERDR_LAB_HELPER" ]; then
  echo "SKIP: HERDR_LAB_HELPER=$HERDR_LAB_HELPER does not exist; it must point at the guarded herdr lab helper." >&2
  exit 2
fi
export HERDR_LAB_HELPER
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name pock-realtime-parity)
export HERDR_LAB_SESSION

# No fixture plugin or warmed agent: this checks the product voice transport.
MUXR_PARITY_EVIDENCE=${MUXR_PARITY_EVIDENCE:-"$ROOT/.realtime-parity/evidence"}
export MUXR_PARITY_EVIDENCE
mkdir -p "$MUXR_PARITY_EVIDENCE"
trap 'rc=$?; "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION"; trc=$?; exit $(( rc || trc ))' EXIT
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
node scripts/diagnostics/application/checkRealtimeParity.mjs
echo "VOICE: the product voice runtime attached through the authenticated link"
echo "NATIVE S2S: not covered by this gate; it requires the device journey runner"
