#!/usr/bin/env bash
set -u
cd "${REVIEW_WORKSPACE:-/demo-shop}"
printf 'muxr Review Agent ready.\nTry: Create review.txt containing hello\n\n'
while IFS= read -r request; do
    normalized=$(printf %s "$request" | tr '[:upper:]' '[:lower:]')
    case "$normalized" in
        *review.txt*)
            printf 'hello from the muxr App Review sandbox\n' > review.txt
            printf 'Done. Created review.txt. Open Changes to read it.\n'
            ;;
        *list*|*files*)
            printf 'Workspace files:\n'
            find . -maxdepth 1 -type f -printf '  %f\n' | sort
            ;;
        *status*) git status --short --branch ;;
        *help*) printf 'Try: Create review.txt containing hello; list files; status\n' ;;
        *)
            printf 'Review fixture received: %s\n' "$request"
            printf 'Try asking it to create review.txt.\n'
            ;;
    esac
    printf '\n'
done
