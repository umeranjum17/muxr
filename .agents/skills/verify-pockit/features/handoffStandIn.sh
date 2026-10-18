#!/usr/bin/env bash
# Stand-in agent for the session.handoff proof. Run it as a process named `pi`
# in a lab Herdr pane (Herdr only accepts prompts for a foreground process of
# its own agent kind). It reports its lifecycle with `herdr pane report-agent`
# and answers a handoff turn by writing the result file the kit asks for.
# Usage: handoffStandIn.sh <herdr-lab-wrapper>. Env STANDIN_LOG (optional) gets the lines it reads.
HERDR="$1"; LOG="${STANDIN_LOG:-/dev/null}"
report() { "$HERDR" pane report-agent --source verify-standin --agent pi --state "$1" "$HERDR_PANE_ID" >/dev/null 2>&1; }
report idle
while IFS= read -r line; do
  printf 'LINE: %s\n' "$line" >> "$LOG"
  case "$line" in
    *"write a UTF-8 JSON file at"*) ;;
    *) continue ;;
  esac
  path=$(printf '%s' "$line" | sed -n 's/.*write a UTF-8 JSON file at "\([^"]*\)".*/\1/p')
  id=$(printf '%s' "$line" | sed -n 's/.*"turnId":"\([^"]*\)".*/\1/p')
  report working
  sleep 1
  printf '{"turnId":"%s","result":{"note":"Continue the lab task. Done: the handoff contract. Left: nothing."}}' "$id" > "$path"
  report idle
done
