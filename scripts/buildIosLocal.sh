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
# The store build's Expo project id decides whether push registration can even
# ask for a token: app.config only publishes extra.eas when this is set, and
# the app reports no native push without it. The value the App Store build
# expects is the one committed in apps/mobile/eas.json under
# build.production.env; it is supplied explicitly so a local archive can never
# quietly fall back to a different project or to none.
: "${MUXR_EAS_PROJECT_ID:?MUXR_EAS_PROJECT_ID is required}"

[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "APP_VERSION must be semantic" >&2; exit 1; }
[[ "$IOS_BUILD_NUMBER" =~ ^[1-9][0-9]*(\.[0-9]+)*$ ]] || { echo "IOS_BUILD_NUMBER must be positive numeric components" >&2; exit 1; }
[[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "APPLE_TEAM_ID is invalid" >&2; exit 1; }
[[ "$IOS_IPA_OUTPUT" = *.ipa ]] || { echo "IOS_IPA_OUTPUT must end in .ipa" >&2; exit 1; }
[ -f "$IOS_CERTIFICATE_PATH" ] || { echo "IOS_CERTIFICATE_PATH does not exist" >&2; exit 1; }
[ -f "$IOS_PROVISIONING_PROFILE_PATH" ] || { echo "IOS_PROVISIONING_PROFILE_PATH does not exist" >&2; exit 1; }
[[ "$MUXR_EAS_PROJECT_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "MUXR_EAS_PROJECT_ID must be a lowercase UUID" >&2; exit 1; }
for command in xcodebuild codesign security node yarn ruby bundle pod openssl unzip plutil shasum git awk; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "The repository must be clean before iOS validation" >&2; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || { echo "Node.js 22 or newer is required" >&2; exit 1; }
xcode_version="$(xcodebuild -version)"
grep -q '^Xcode 26\.' <<< "$xcode_version" || { echo "Xcode 26 is required" >&2; exit 1; }
if [[ "$IOS_IPA_OUTPUT" != /* ]]; then
  IOS_IPA_OUTPUT="$PWD/$IOS_IPA_OUTPUT"
  export IOS_IPA_OUTPUT
fi

export APP_ENV=production
export MUXR_PUBLIC_BASE_URL=https://trymuxr.com
export MUXR_DISTRIBUTION=store
export MUXR_EAS_PROJECT_ID
# Metro inlines these at bundle time and they are not part of app.config, so
# they cannot be checked in the archive afterwards. Dropping them does not
# fall back to the hosted relay: the mode does default to hosted, but the
# relay URL defaults to a loopback address, which is not what a store build
# declares. Take the declared values from the committed production profile
# rather than restating them here. Credentials are never baked in.
store_profile="$ROOT/apps/mobile/eas.json"
for store_key in EXPO_PUBLIC_MUXR_MODE EXPO_PUBLIC_MUXR_RELAY_URL; do
  store_value="$(node -e 'const {env}=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).build.production;process.stdout.write(env[process.argv[2]] ?? "")' "$store_profile" "$store_key")"
  [ -n "$store_value" ] || { echo "$store_key is missing from the production build profile" >&2; exit 1; }
  export "$store_key=$store_value"
done
unset EXPO_PUBLIC_MUXR_TOKEN EXPO_PUBLIC_MUXR_MACHINE_ID

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

# PlistBuddy renders a boolean and the string "false" the same way, and a
# profile may authorise domains with a scalar wildcard rather than a list, so
# the checks that turn on type read the plist as JSON. A conversion that fails
# aborts rather than reading as an absent key.
entitlements_json() { plutil -convert json -o "$2" "$1"; }
debuggable_entitlement() {
  ENTITLEMENTS_JSON="$1" node -e 'const entitlements = JSON.parse(require("fs").readFileSync(process.env.ENTITLEMENTS_JSON, "utf8"));
const value = entitlements["get-task-allow"];
process.stdout.write(value === undefined || value === false ? "no" : `yes (${JSON.stringify(value)})`);'
}
associated_domain_allowed() {
  ENTITLEMENTS_JSON="$1" node -e 'const entitlements = JSON.parse(require("fs").readFileSync(process.env.ENTITLEMENTS_JSON, "utf8"));
const declared = entitlements["com.apple.developer.associated-domains"];
const [required, mode] = process.argv.slice(1);
const entries = Array.isArray(declared) ? declared : [declared];
// A profile may carry the wildcard that authorises every domain; a signed app
// and the project always name the concrete domain.
process.stdout.write(entries.some((entry) => entry === required || (mode === "authorises" && entry === "*")) ? "yes" : "no");' "$2" "$3"
}

security cms -D -i "$IOS_PROVISIONING_PROFILE_PATH" > "$profile_plist"
profile_uuid="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$profile_plist")"
profile_name="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$profile_plist")"
profile_team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$profile_plist")"
application_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$profile_plist")"
get_task_allow="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:get-task-allow' "$profile_plist" 2>/dev/null || true)"
[ "$profile_team" = "$APPLE_TEAM_ID" ] || { echo "Provisioning profile team does not match APPLE_TEAM_ID" >&2; exit 1; }
[ "$application_id" = "$APPLE_TEAM_ID.com.trymuxr.app" ] || { echo "Provisioning profile application identifier is invalid" >&2; exit 1; }
[ "$get_task_allow" = false ] || { echo "A non-debug provisioning profile is required" >&2; exit 1; }
# The signed archive can only carry what both the profile and the project
# declare, so disagreement is caught here rather than after the build.
profile_aps="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:aps-environment' "$profile_plist" 2>/dev/null || true)"
[ "$profile_aps" = production ] || { echo "The provisioning profile does not authorise production push" >&2; exit 1; }
profile_entitlements="$workdir/profile-entitlements.json"
plutil -extract Entitlements json -o "$profile_entitlements" "$profile_plist"
[ "$(associated_domain_allowed "$profile_entitlements" applinks:trymuxr.com authorises)" = yes ] || { echo "The provisioning profile does not authorise the trymuxr.com associated domain" >&2; exit 1; }
project_entitlements="$workdir/project-entitlements.json"
entitlements_json "$ROOT/apps/mobile/ios/muxr/muxr.entitlements" "$project_entitlements"
[ "$(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$ROOT/apps/mobile/ios/muxr/muxr.entitlements")" = production ] || { echo "The project does not declare production push" >&2; exit 1; }
[ "$(associated_domain_allowed "$project_entitlements" applinks:trymuxr.com exact)" = yes ] || { echo "The project does not declare the trymuxr.com associated domain" >&2; exit 1; }

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
# The framework a build links is downloaded, never committed. Recompute its
# library bytes before pods so a tree that skipped postinstall fails here
# rather than archiving whatever binary happens to be extracted.
node "$ROOT/scripts/diagnostics/application/syncIosFramework.mjs" --verify
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

commit_sha="$(git -C "$ROOT" rev-parse HEAD)"
payload="$workdir/payload"
unzip -q "$IOS_IPA_OUTPUT" -d "$payload"
app="$payload/${mapfile_entry%/Info.plist}"
[ -d "$app" ] || { echo "The IPA does not contain the expected app bundle" >&2; exit 1; }

# An unsigned or development-signed export drops the capabilities the app
# declares without failing, so the signature the IPA actually ships is what
# gets checked, not the settings that were asked for.
codesign --verify --deep --strict "$app" || { echo "The exported app is not validly signed" >&2; exit 1; }
signature="$workdir/signature.txt"
codesign -dvvv "$app" > "$signature" 2>&1
[ "$(awk -F= '/^TeamIdentifier=/{print $2}' "$signature")" = "$APPLE_TEAM_ID" ] || { echo "The signed app is not from the expected team" >&2; exit 1; }
signing_identity="$(awk -F= '/^Authority=/{print $2; exit}' "$signature")"
case "$signing_identity" in
  "Apple Distribution: "*|"iPhone Distribution: "*) ;;
  *) echo "The app is not signed with a distribution identity: $signing_identity" >&2; exit 1 ;;
esac

entitlements="$workdir/entitlements.plist"
codesign -d --entitlements :- --xml "$app" > "$entitlements"
plutil -lint "$entitlements" >/dev/null
signed_entitlement() { /usr/libexec/PlistBuddy -c "Print :$1" "$entitlements" 2>/dev/null || true; }
[ "$(signed_entitlement aps-environment)" = production ] || { echo "The signed app does not carry production push" >&2; exit 1; }
[ "$(signed_entitlement application-identifier)" = "$APPLE_TEAM_ID.com.trymuxr.app" ] || { echo "The signed application identifier is wrong" >&2; exit 1; }
[ "$(signed_entitlement com.apple.developer.team-identifier)" = "$APPLE_TEAM_ID" ] || { echo "The signed team identifier is wrong" >&2; exit 1; }
signed_entitlements="$workdir/entitlements.json"
entitlements_json "$entitlements" "$signed_entitlements"
# A store signature normally omits get-task-allow entirely; boolean false is
# equally non-debug. Any other value, of any type, is not shippable.
debuggable="$(debuggable_entitlement "$signed_entitlements")"
[ "$debuggable" = no ] || { echo "The signed app is debuggable: get-task-allow is $debuggable" >&2; exit 1; }
[ "$(associated_domain_allowed "$signed_entitlements" applinks:trymuxr.com exact)" = yes ] || { echo "The signed app is missing the trymuxr.com associated domain" >&2; exit 1; }

embedded_plist="$workdir/embedded.plist"
security cms -D -i "$app/embedded.mobileprovision" > "$embedded_plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$embedded_plist")" = "$profile_uuid" ] || { echo "The IPA embeds a different provisioning profile" >&2; exit 1; }

# Push registration reads the project id out of this file at runtime, so an
# archive built without it reports no native push however well it is signed.
app_config="$app/EXConstants.bundle/app.config"
[ -f "$app_config" ] || { echo "The app bundle does not contain EXConstants.bundle/app.config" >&2; exit 1; }
config_value() {
  APP_CONFIG="$app_config" node -e 'const config = JSON.parse(require("fs").readFileSync(process.env.APP_CONFIG, "utf8"));
const value = process.argv.slice(1).reduce((node, key) => (node === undefined ? undefined : node[key]), config);
process.stdout.write(value === undefined ? "" : String(value));' "$@"
}
[ "$(config_value extra eas projectId)" = "$MUXR_EAS_PROJECT_ID" ] || { echo "The archive does not embed the required Expo project id" >&2; exit 1; }
[ "$(config_value extra app publicBaseUrl)" = "$MUXR_PUBLIC_BASE_URL" ] || { echo "The archive embeds a different public base URL" >&2; exit 1; }
[ "$(config_value extra app directDistribution)" = false ] || { echo "The archive is not configured for store distribution" >&2; exit 1; }
[ "$(config_value extra app consoleLoggingDefault)" = false ] || { echo "The archive would log to the console by default" >&2; exit 1; }
[ "$(config_value extra app releaseVersion)" = "$APP_VERSION" ] || { echo "The archive embeds a different release version" >&2; exit 1; }
[ "$(config_value extra app buildCommitSha)" = "$commit_sha" ] || { echo "The archive embeds a different source commit" >&2; exit 1; }

ipa_sha256="$(shasum -a 256 "$IOS_IPA_OUTPUT" | awk '{print $1}')"
entitlements_sha256="$(shasum -a 256 "$entitlements" | awk '{print $1}')"
app_config_sha256="$(shasum -a 256 "$app_config" | awk '{print $1}')"
podfile_lock="$ROOT/apps/mobile/ios/Podfile.lock"
[ -f "$podfile_lock" ] || { echo "pod install did not produce Podfile.lock" >&2; exit 1; }
podfile_lock_sha256="$(shasum -a 256 "$podfile_lock" | awk '{print $1}')"
ghostty_libraries="$(cd "$ROOT/node_modules/expo-libghostty/ios/vendor/Frameworks/GhosttyKit.xcframework" \
  && shasum -a 256 ios-arm64/libghostty.a ios-arm64_x86_64-simulator/libghostty.a | awk '{printf "%s=%s ", $2, $1}')"
printf '%s\n' \
  "iOS archive validation passed" \
  "commit: $commit_sha" \
  "version: $APP_VERSION" \
  "build: $IOS_BUILD_NUMBER" \
  "xcode: ${xcode_version//$'\n'/; }" \
  "ipa_sha256: $ipa_sha256" \
  "podfile_lock_sha256: $podfile_lock_sha256" \
  "ghostty_libraries: $ghostty_libraries" \
  "entitlements_sha256: $entitlements_sha256" \
  "app_config_sha256: $app_config_sha256" \
  "signing_identity: $signing_identity" \
  "profile_uuid: $profile_uuid" \
  "eas_project_id: $MUXR_EAS_PROJECT_ID" \
  "build_env: EXPO_PUBLIC_MUXR_MODE=$EXPO_PUBLIC_MUXR_MODE EXPO_PUBLIC_MUXR_RELAY_URL=$EXPO_PUBLIC_MUXR_RELAY_URL (Metro inputs, not app.config keys)" \
  "ipa: $IOS_IPA_OUTPUT"
