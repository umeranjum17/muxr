# Native Android build

muxr Android builds run locally with EAS. Do not use cloud EAS build
credits. Phone artifacts default to `arm64-v8a`; build `x86_64` only when an
emulator explicitly needs it.

**Expo Go will not work.** The app ships custom native modules
(`voice-overlay`, `ssh-tunnel`) and `patch-package` patches. Use a locally built
APK or `expo run:android` after a prebuild.

**iOS compiles but is incomplete.** Both local native modules are Android-only
Kotlin. An iOS build will lack the voice overlay microphone foreground service
and in-app SSH forwarding.

`apps/mobile/android/` is the committed production prebuild for
`com.trymuxr.app`. Do not change that permanent store identity. Regenerate the
prebuild only with `APP_ENV=production`, `MUXR_APP_ID_BASE=com.trymuxr.app`, and
`MUXR_PUBLIC_BASE_URL=https://trymuxr.com`; otherwise local app-config defaults
can silently replace the committed identity.

The first `eas build --local` creates a keystore through your Expo account
(`eas credentials` in `apps/mobile`). `credentials.json` is gitignored; do not
commit it. Android launcher shortcuts from bundled plugins are baked into
`res/xml/shortcuts.xml` at prebuild, so changing `plugins/*/muxr-ui.json`
shortcuts requires a new APK.

In-app SSH (Settings → SSH) is TOFU host-key pinning via
`apps/mobile/modules/ssh-tunnel`. It is Android-only.

## Toolchain

| Requirement | Version used |
|---|---|
| Node.js | 22+ |
| Yarn | 1.x |
| JDK | 21 |
| Android SDK | platforms/build-tools 35–36 |
| Android NDK | 27.1.12297006 |
| CMake | 3.22.1 |
| EAS account | Free account, linked project, Android keystore |

Set the Android and Java paths when they are not in their conventional locations:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="/path/to/jdk-21"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

Give Gradle enough memory in `~/.gradle/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx8g -XX:MaxMetaspaceSize=4g
kotlin.daemon.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=2g
```

Without this, Kotlin/Gradle can fail with misleading type-tag errors after JVM
metaspace exhaustion.

## Hosted connection configuration

Hosted builds compile only the public relay origin; device credentials and E2EE
keys are created at runtime and live in platform SecureStore:

```json
{
  "EXPO_PUBLIC_MUXR_RELAY_URL": "wss://<hostname>"
}
```

`scripts/buildAndroidLocal.sh` defaults to `EXPO_PUBLIC_MUXR_MODE=hosted` and
unsets public token/shared-key variables. For the internal LAN fixture only,
set `EXPO_PUBLIC_MUXR_MODE=local` explicitly and provide its local connection
values. Never distribute a build containing fixture credentials.

## Publishing identity

`apps/mobile/app.config.js` uses one owner-supplied identifier and one public
origin for both platforms:

```bash
export MUXR_APP_ID_BASE='<owner-controlled reverse-DNS identifier>'
export MUXR_PUBLIC_BASE_URL='https://<owner-controlled-origin>'
```

`APP_ENV=production` requires both values and uses `MUXR_APP_ID_BASE` unchanged
for Android and iOS. Development appends `.dev`; preview appends `.preview`.
Without an owner value, only local builds are configured, as
`app.muxr.local.dev` and `app.muxr.local.preview`. `MUXR_PUBLIC_BASE_URL`
has no default and must be the HTTPS origin that will host activation plus iOS
Universal Link and Android App Link association files.

Set `MUXR_EAS_PROJECT_ID` only after creating or transferring the owner’s muxr
project. Signed store releases use the manual EAS Cloud workflow documented in
`RELEASING.md`; do not distribute a direct Gradle build, which has no owner
release credential. Local EAS profiles remain available for development APKs.
Changing the production app identifier creates a separate store identity unless
the owner arranges a transfer/update under the final identifier.

## Fast bundle check

Before a native build, catch Metro/import failures in seconds:

```bash
cd apps/mobile
../../node_modules/.bin/expo export:embed --eager --platform android --dev false
```

## Build a phone APK

Run from the repository root:

```bash
export MUXR_APK_OUTPUT="$PWD/muxr-arm64.apk"
scripts/buildAndroidLocal.sh
```

The script:

1. defaults to `arm64-v8a`;
2. applies and verifies required native patches;
3. validates the bundled Whisper Base model checksum;
4. builds TypeScript and focused native/voice tests;
5. runs `eas build --local` and writes exactly one APK.

For an x86_64 emulator build only:

```bash
ORG_GRADLE_PROJECT_reactNativeArchitectures=x86_64 \
MUXR_APK_OUTPUT="$PWD/muxr-emulator.apk" \
  scripts/buildAndroidLocal.sh
```

Do not publish an x86_64 build as the phone artifact.

## Verify the APK

```bash
APK=muxr-arm64.apk
sha256sum "$APK"
unzip -l "$APK" | awk '$4 ~ /^lib\// {split($4,p,"/"); print p[2]}' | sort -u

"$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)/apksigner" \
  verify --verbose "$APK"
```

Expect only `arm64-v8a`, a valid v2 signature, the bundled Whisper model, and no
Sherpa/ONNX wake-word assets.

## TLS requirement

The Android app validates TLS with the system trust store and does not accept a
self-signed certificate. Use a publicly trusted certificate, such as a Tailscale
HTTPS certificate, and verify it without `-k`:

```bash
curl -sS https://<hostname>:8445/health
```

A build with a self-signed endpoint typically installs correctly but remains
stuck disconnected.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Node engine mismatch | Build shell uses Node 20 | Select Node 22 before running the script |
| Metro cannot resolve workspace packages | Workspace `dist/` is missing | Run `yarn build`; the EAS post-install does this too |
| Gradle daemon disappears/type-tag errors | JVM memory exhaustion | Apply the Gradle memory settings above |
| App installs but never connects | Missing baked connection values | Check the secrets file or Settings → Connection |
| App remains disconnected over HTTPS | Self-signed or invalid TLS chain | Install a trusted certificate |
| Native recorder/terminal verifier fails | `patch-package` output is stale | Run `yarn install`, then `node scripts/verifyNativePatches.mjs` |

## OTA updates

JavaScript-only changes can ship to an installed preview binary when its runtime
and channel match:

```bash
cd apps/mobile
eas update --channel preview --message "describe the change"
```

Native dependency or native module changes require a new locally built APK and a
runtime-version bump when compatibility changes.
