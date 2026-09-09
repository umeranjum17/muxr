#!/usr/bin/env bash
set -euo pipefail

android_app_version="${APP_VERSION-}"
android_version_code="${ANDROID_VERSION_CODE-}"
android_store_file="${ANDROID_UPLOAD_STORE_FILE-}"
android_store_password="${ANDROID_UPLOAD_STORE_PASSWORD-}"
android_key_alias="${ANDROID_UPLOAD_KEY_ALIAS-}"
android_key_password="${ANDROID_UPLOAD_KEY_PASSWORD-}"
unset APP_VERSION ANDROID_VERSION_CODE ANDROID_UPLOAD_STORE_FILE ANDROID_UPLOAD_STORE_PASSWORD ANDROID_UPLOAD_KEY_ALIAS ANDROID_UPLOAD_KEY_PASSWORD
unset ORG_GRADLE_PROJECT_appVersion ORG_GRADLE_PROJECT_androidVersionCode ORG_GRADLE_PROJECT_releaseStoreFile ORG_GRADLE_PROJECT_releaseStorePassword ORG_GRADLE_PROJECT_releaseKeyAlias ORG_GRADLE_PROJECT_releaseKeyPassword

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

export ORG_GRADLE_PROJECT_reactNativeArchitectures="${ORG_GRADLE_PROJECT_reactNativeArchitectures:-arm64-v8a}"
export APP_ENV="${APP_ENV:-preview}"
unset EXPO_PUBLIC_MUXR_MODE EXPO_PUBLIC_MUXR_RELAY_URL EXPO_PUBLIC_MUXR_TOKEN EXPO_PUBLIC_MUXR_MACHINE_ID

android_app_version="${android_app_version:-$(read_secret APP_VERSION)}"
android_version_code="${android_version_code:-$(read_secret ANDROID_VERSION_CODE)}"
android_store_file="${android_store_file:-$(read_secret ANDROID_UPLOAD_STORE_FILE)}"
android_store_password="${android_store_password:-$(read_secret ANDROID_UPLOAD_STORE_PASSWORD)}"
android_key_alias="${android_key_alias:-$(read_secret ANDROID_UPLOAD_KEY_ALIAS)}"
android_key_password="${android_key_password:-$(read_secret ANDROID_UPLOAD_KEY_PASSWORD)}"

for value in "$android_app_version" "$android_version_code" "$android_store_file" "$android_store_password" "$android_key_alias" "$android_key_password"; do
  [ -n "$value" ] || { echo "Android version and upload signing values are required" >&2; exit 1; }
done
[[ "$android_app_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "APP_VERSION must be semantic" >&2; exit 1; }
[[ "$android_version_code" =~ ^[1-9][0-9]*$ ]] || { echo "ANDROID_VERSION_CODE must be positive" >&2; exit 1; }
[ -f "$android_store_file" ] || { echo "ANDROID_UPLOAD_STORE_FILE must exist" >&2; exit 1; }
android_store_file="$(cd "$(dirname "$android_store_file")" && pwd)/$(basename "$android_store_file")"

cd "$MOBILE"
# Apply from the workspace root: running patch-package from apps/mobile is a
# successful no-op and can let stale native code reach a build.
(cd "$ROOT" && npx patch-package --error-on-fail >/dev/null)
node "$ROOT/scripts/diagnostics/application/verifyNativePatches.mjs"
(cd "$ROOT" && yarn build)
(cd "$ROOT" && npx vitest run \
  apps/mobile/sources/terminal/application/ghosttyPatch.spec.ts \
  apps/mobile/sources/conversation/application/realtimeSession.spec.ts \
  apps/mobile/sources/utils/dictation.spec.ts \
  --root "$ROOT") || {
  echo "required native audio/terminal patch or voice checks failed -- refusing to build" >&2
  exit 1
}

echo "java: $(java -version 2>&1 | head -1)"
echo "architectures: $ORG_GRADLE_PROJECT_reactNativeArchitectures"

OUTPUT="${MUXR_APK_OUTPUT:-$ROOT/muxr-preview.apk}"
rm -rf android/app/build/outputs/apk/release
ORG_GRADLE_PROJECT_appVersion="$android_app_version" \
ORG_GRADLE_PROJECT_androidVersionCode="$android_version_code" \
ORG_GRADLE_PROJECT_releaseStoreFile="$android_store_file" \
ORG_GRADLE_PROJECT_releaseStorePassword="$android_store_password" \
ORG_GRADLE_PROJECT_releaseKeyAlias="$android_key_alias" \
ORG_GRADLE_PROJECT_releaseKeyPassword="$android_key_password" \
  android/gradlew -p android :app:assembleRelease
unset android_store_password android_key_password
mapfile -t apks < <(find android/app/build/outputs/apk/release -type f -name '*.apk')
[ "${#apks[@]}" -eq 1 ] || { echo "expected exactly one release APK" >&2; exit 1; }
mkdir -p "$(dirname "$OUTPUT")"
install -m 600 "${apks[0]}" "$OUTPUT"
