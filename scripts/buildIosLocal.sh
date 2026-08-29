#!/usr/bin/env bash
set -euo pipefail

: "${IOS_CERTIFICATE_PASSWORD:?IOS_CERTIFICATE_PASSWORD is required}"
ios_certificate_password="$IOS_CERTIFICATE_PASSWORD"
unset IOS_CERTIFICATE_PASSWORD

[ "$(uname -s)" = Darwin ] || { echo "iOS builds require macOS" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${APP_VERSION:?APP_VERSION is required}"
: "${IOS_BUILD_NUMBER:?IOS_BUILD_NUMBER is required}"
: "${IOS_CERTIFICATE_PATH:?IOS_CERTIFICATE_PATH is required}"
: "${IOS_PROVISIONING_PROFILE_PATH:?IOS_PROVISIONING_PROFILE_PATH is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
: "${IOS_IPA_OUTPUT:?IOS_IPA_OUTPUT is required}"

[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "APP_VERSION must be semantic" >&2; exit 1; }
[[ "$IOS_BUILD_NUMBER" =~ ^[1-9][0-9]*(\.[0-9]+)*$ ]] || { echo "IOS_BUILD_NUMBER must be positive numeric components" >&2; exit 1; }
[[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "APPLE_TEAM_ID is invalid" >&2; exit 1; }
[[ "$IOS_IPA_OUTPUT" = *.ipa ]] || { echo "IOS_IPA_OUTPUT must end in .ipa" >&2; exit 1; }
[ -f "$IOS_CERTIFICATE_PATH" ] || { echo "IOS_CERTIFICATE_PATH does not exist" >&2; exit 1; }
[ -f "$IOS_PROVISIONING_PROFILE_PATH" ] || { echo "IOS_PROVISIONING_PROFILE_PATH does not exist" >&2; exit 1; }
for command in xcodebuild security node yarn ruby bundle pod openssl unzip plutil; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || { echo "Node.js 22 or newer is required" >&2; exit 1; }
xcodebuild -version | grep -q '^Xcode 26\.' || { echo "Xcode 26 is required" >&2; exit 1; }
if [[ "$IOS_IPA_OUTPUT" != /* ]]; then
  IOS_IPA_OUTPUT="$PWD/$IOS_IPA_OUTPUT"
  export IOS_IPA_OUTPUT
fi

export APP_ENV=production
export MUXR_PUBLIC_BASE_URL=https://trymuxr.com
export MUXR_DISTRIBUTION=store
unset EXPO_PUBLIC_MUXR_MODE EXPO_PUBLIC_MUXR_RELAY_URL EXPO_PUBLIC_MUXR_TOKEN EXPO_PUBLIC_MUXR_MACHINE_ID

(cd "$ROOT" && yarn install --frozen-lockfile --non-interactive)
(cd "$ROOT" && (bundle check || bundle install))
(cd "$ROOT" && yarn build)
(cd "$ROOT" && yarn workspace @muxr/mobile typecheck)
(cd "$ROOT" && yarn workspace @muxr/mobile vitest run sources/account/application/accountSession.integration.spec.ts sources/catalog/application/sessionSync.integration.spec.ts)
node "$ROOT/scripts/diagnostics/application/checkMobileCommerceBuilds.mjs"
node "$ROOT/scripts/diagnostics/application/checkNoSecrets.mjs"
node "$ROOT/scripts/diagnostics/application/verifyNativePatches.mjs"

workdir="$(mktemp -d "${TMPDIR:-/tmp}/muxr-ios.XXXXXX")"
keychain="$workdir/build.keychain-db"
keychain_password="$(openssl rand -hex 24)"
profile_plist="$workdir/profile.plist"
installed_profile=""
original_default="$(security default-keychain -d user | tr -d '"')"
original_keychains=()
while IFS= read -r keychain_path; do
  original_keychains+=("$keychain_path")
done < <(security list-keychains -d user | sed 's/^[[:space:]]*"//; s/"$//')

cleanup() {
  security default-keychain -d user -s "$original_default" >/dev/null 2>&1 || true
  security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  [ -z "$installed_profile" ] || rm -f "$installed_profile"
  rm -rf "$workdir"
}
trap cleanup EXIT

security cms -D -i "$IOS_PROVISIONING_PROFILE_PATH" > "$profile_plist"
profile_uuid="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$profile_plist")"
profile_name="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$profile_plist")"
profile_team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$profile_plist")"
application_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$profile_plist")"
get_task_allow="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:get-task-allow' "$profile_plist" 2>/dev/null || true)"
[ "$profile_team" = "$APPLE_TEAM_ID" ] || { echo "Provisioning profile team does not match APPLE_TEAM_ID" >&2; exit 1; }
[ "$application_id" = "$APPLE_TEAM_ID.com.trymuxr.app" ] || { echo "Provisioning profile application identifier is invalid" >&2; exit 1; }
[ "$get_task_allow" = false ] || { echo "A non-debug provisioning profile is required" >&2; exit 1; }

profiles_dir="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$profiles_dir"
profile_destination="$profiles_dir/$profile_uuid.mobileprovision"
if [ ! -e "$profile_destination" ]; then
  install -m 600 "$IOS_PROVISIONING_PROFILE_PATH" "$profile_destination"
  installed_profile="$profile_destination"
elif ! cmp -s "$IOS_PROVISIONING_PROFILE_PATH" "$profile_destination"; then
  echo "A different provisioning profile with this UUID is already installed" >&2
  exit 1
fi

security create-keychain -p "$keychain_password" "$keychain" >/dev/null
security set-keychain-settings -lut 21600 "$keychain" >/dev/null
security unlock-keychain -p "$keychain_password" "$keychain" >/dev/null
security import "$IOS_CERTIFICATE_PATH" -k "$keychain" -P "$ios_certificate_password" -T /usr/bin/codesign >/dev/null 2>&1
unset ios_certificate_password
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null 2>&1
security list-keychains -d user -s "$keychain" "${original_keychains[@]}" >/dev/null
security default-keychain -d user -s "$keychain" >/dev/null
security find-identity -v -p codesigning "$keychain" | grep -q '1)'

mkdir -p "$(dirname "$IOS_IPA_OUTPUT")"
(cd "$ROOT/apps/mobile/ios" && pod install)
export IOS_PROFILE_NAME="$profile_name"
(cd "$ROOT" && bundle exec fastlane ios build_internal)

[ -f "$IOS_IPA_OUTPUT" ] || { echo "The iOS build did not produce an IPA" >&2; exit 1; }
mapfile_path="$workdir/Info.plist"
mapfile_entry="$(unzip -Z1 "$IOS_IPA_OUTPUT" | grep -E '^Payload/[^/]+\.app/Info\.plist$')"
[ "$(printf '%s\n' "$mapfile_entry" | wc -l | tr -d ' ')" -eq 1 ] || { echo "The IPA app metadata is ambiguous" >&2; exit 1; }
unzip -p "$IOS_IPA_OUTPUT" "$mapfile_entry" > "$mapfile_path"
[ "$(plutil -extract CFBundleIdentifier raw "$mapfile_path")" = com.trymuxr.app ]
[ "$(plutil -extract CFBundleShortVersionString raw "$mapfile_path")" = "$APP_VERSION" ]
[ "$(plutil -extract CFBundleVersion raw "$mapfile_path")" = "$IOS_BUILD_NUMBER" ]
