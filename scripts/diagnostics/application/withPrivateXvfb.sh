#!/usr/bin/env bash
# Runs a lab command on a private Xvfb display and stops that Xvfb when the
# command exits, so no lab run leaves a display behind.
#
# Usage: withPrivateXvfb.sh <command> [args...]
# The command gets DISPLAY=:<n> and XVFB_PID=<pid of its own Xvfb>.
set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "usage: withPrivateXvfb.sh <command> [args...]" >&2
    exit 2
fi

number=90
while [ -e "/tmp/.X$number-lock" ] || [ -e "/tmp/.X11-unix/X$number" ]; do number=$((number + 1)); done

Xvfb ":$number" -screen 0 1280x800x24 -nolisten tcp &
xvfb=$!
# Stops only the Xvfb this script started, and reaps it before exiting.
trap 'kill "$xvfb" 2>/dev/null || true; wait "$xvfb" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM HUP

ready() {
    [ -S "/tmp/.X11-unix/X$number" ] || return 1
    [ "$(cat "/tmp/.X$number-lock" 2>/dev/null | tr -d ' ')" = "$xvfb" ]
}

for _ in $(seq 100); do
    kill -0 "$xvfb" 2>/dev/null || { echo "Xvfb :$number did not start" >&2; exit 1; }
    ready && break
    sleep 0.1
done
ready || { echo "Xvfb :$number never became ready" >&2; exit 1; }

XVFB_PID="$xvfb" DISPLAY=":$number" "$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' INT TERM HUP
status=0
wait "$child" || status=$?
while kill -0 "$child" 2>/dev/null; do wait "$child" || status=$?; done
exit "$status"
