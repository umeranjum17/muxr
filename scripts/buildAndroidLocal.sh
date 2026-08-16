#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="$ROOT/apps/mobile"
SECRETS="${MUXR_SECRETS_FILE:-$HOME/.muxr/deploy-secrets.json}"

read_secret() {
  [ -f "$SECRETS" ] || return 0
  node -e 'const p=require(process.argv[1]); process.stdout.write(String(p[process.argv[2]] ?? ""))' "$SECRETS" "$1"
}

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
if [ -z "${JAVA_HOME:-}" ]; then
  java_bin="$(command -v java || true)"
  [ -n "$java_bin" ] || { echo "Java 21 is required (set JAVA_HOME)" >&2; exit 1; }
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$java_bin")")")"
  export JAVA_HOME
fi
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

export EXPO_PUBLIC_MUXR_RELAY_URL="${EXPO_PUBLIC_MUXR_RELAY_URL:-$(read_secret EXPO_PUBLIC_MUXR_RELAY_URL)}"
export EXPO_PUBLIC_MUXR_MACHINE_ID="${EXPO_PUBLIC_MUXR_MACHINE_ID:-$(read_secret EXPO_PUBLIC_MUXR_MACHINE_ID)}"
export EXPO_PUBLIC_MUXR_MODE="${EXPO_PUBLIC_MUXR_MODE:-hosted}"
if [ "$EXPO_PUBLIC_MUXR_MODE" = local ]; then
  export EXPO_PUBLIC_MUXR_TOKEN="${EXPO_PUBLIC_MUXR_TOKEN:-$(read_secret MUXR_TOKEN)}"
else
  unset EXPO_PUBLIC_MUXR_TOKEN EXPO_PUBLIC_MUXR_E2EE_KEY
fi
export ORG_GRADLE_PROJECT_reactNativeArchitectures="${ORG_GRADLE_PROJECT_reactNativeArchitectures:-arm64-v8a}"
export APP_ENV="${APP_ENV:-preview}"

for name in EXPO_PUBLIC_MUXR_RELAY_URL; do
  [ -n "${!name}" ] || { echo "$name is required; set it or add it to $SECRETS" >&2; exit 1; }
done

mkdir -p "$HOME/.cache"
EAS_LOCAL_BUILD_WORKINGDIR="$(mktemp -d "$HOME/.cache/eas-local-build.XXXXXX")"
export EAS_LOCAL_BUILD_WORKINGDIR
trap 'rm -rf "$EAS_LOCAL_BUILD_WORKINGDIR"' EXIT

cd "$MOBILE"
# Apply from the workspace root: running patch-package from apps/mobile is a
# successful no-op and can let stale native code reach a build.
(cd "$ROOT" && npx patch-package --error-on-fail >/dev/null)
node "$ROOT/scripts/verifyNativePatches.mjs"
(cd "$ROOT" && yarn build)
(cd "$ROOT" && npx vitest run \
  apps/mobile/sources/terminal/ghosttyPatch.spec.ts \
  apps/mobile/sources/voice/realtimeSession.spec.ts \
  apps/mobile/sources/voice/paneTools.spec.ts \
  apps/mobile/sources/utils/dictation.spec.ts \
  --root "$ROOT") || {
  echo "required native audio/terminal patch or voice checks failed -- refusing to build" >&2
  exit 1
}

echo "java: $(java -version 2>&1 | head -1)"
echo "mode: $EXPO_PUBLIC_MUXR_MODE  relay: $EXPO_PUBLIC_MUXR_RELAY_URL"
echo "architectures: $ORG_GRADLE_PROJECT_reactNativeArchitectures"
if [ "$EXPO_PUBLIC_MUXR_MODE" = local ]; then echo "local token len: ${#EXPO_PUBLIC_MUXR_TOKEN}"; fi

OUTPUT="${MUXR_APK_OUTPUT:-$ROOT/muxr-preview.apk}"
npx eas-cli@21.6.0 build --platform android --profile preview --local --non-interactive \
  --output "$OUTPUT"
