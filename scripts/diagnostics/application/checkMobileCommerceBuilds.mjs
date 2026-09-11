import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const mobile = join(root, 'apps', 'mobile');

function config(distribution) {
    const output = execFileSync('npx', ['expo', 'config', '--json'], {
        cwd: mobile,
        encoding: 'utf8',
        env: {
            ...process.env,
            APP_ENV: 'production',
            MUXR_APP_ID_BASE: 'com.trymuxr.app',
            MUXR_PUBLIC_BASE_URL: 'https://muxr.test',
            MUXR_DISTRIBUTION: distribution,
        },
    });
    return JSON.parse(output);
}

const store = config('store');
const direct = config('direct');
assert.equal(store.extra.app.directDistribution, false, 'store production config exposed direct-distribution behavior');
assert.equal(direct.extra.app.directDistribution, true, 'direct APK production config lost direct-distribution behavior');
assert.equal(store.extra.app.publicBaseUrl, 'https://muxr.test');
assert.equal(store.android.package, 'com.trymuxr.app', 'production config lost the permanent Play application id');
assert.doesNotMatch(JSON.stringify(store), /revenuecat|posthog|stripeKey|checkout|upgrade|purchase|displayPrice/i, 'store production config contains commerce or analytics material');

const eas = JSON.parse(readFileSync(join(mobile, 'eas.json'), 'utf8'));
assert.equal(eas.build.production.env.ORG_GRADLE_PROJECT_reactNativeArchitectures, 'arm64-v8a');
const podProperties = JSON.parse(readFileSync(join(mobile, 'ios', 'Podfile.properties.json'), 'utf8'));
assert.equal(podProperties['ios.deploymentTarget'], '16.4', 'iOS target must satisfy expo-libghostty');
const xcodeProject = readFileSync(join(mobile, 'ios', 'muxr.xcodeproj', 'project.pbxproj'), 'utf8');
// Check each build configuration by the target it belongs to. Counting
// occurrences broke the moment the widget extension added its own pair, and a
// count can never say which target lost the setting.
const xcodeConfigSection = xcodeProject.slice(
    xcodeProject.indexOf('/* Begin XCBuildConfiguration section */'),
    xcodeProject.indexOf('/* End XCBuildConfiguration section */'),
);
const xcodeConfigs = [...xcodeConfigSection.matchAll(/\n\t\t[0-9A-F]{24} \/\* (\w+) \*\/ = \{([\s\S]*?)\n\t\t\};/g)]
    .map(([, name, body]) => ({
        name,
        bundleId: body.match(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.$()-]+)"?;/)?.[1] ?? null,
        deploymentTarget: body.match(/IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);/)?.[1] ?? null,
    }));
assert.ok(xcodeConfigs.length > 0, 'Xcode project declares no build configurations');
for (const { name, bundleId, deploymentTarget } of xcodeConfigs) {
    const label = bundleId === null ? `project-level ${name}` : `${bundleId} ${name}`;
    assert.ok(deploymentTarget !== null, `Xcode configuration ${label} declares no deployment target`);
    assert.ok(Number(deploymentTarget) >= 16.4, `Xcode configuration ${label} is below the expo-libghostty minimum`);
}
// Named explicitly so a target that disappears is a failure, not a smaller count.
for (const bundleId of ['com.trymuxr.app', 'com.trymuxr.app.activity']) {
    const configured = xcodeConfigs.filter((entry) => entry.bundleId === bundleId).map((entry) => entry.name).sort();
    assert.deepEqual(configured, ['Debug', 'Release'], `expected Debug and Release build configurations for ${bundleId}`);
}
assert.ok(
    xcodeProject.includes('export PROJECT_ROOT=\\\"$(cd \\\"$PROJECT_DIR/..\\\" && pwd -P)\\\"'),
    'Xcode bundle phase does not canonicalize the workspace path before resolving the entry file',
);
assert.match(readFileSync(join(mobile, 'android', 'app', 'build.gradle'), 'utf8'), /applicationId 'com\.trymuxr\.app'/);
const androidManifest = readFileSync(join(mobile, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
assert.match(androidManifest, /<intent-filter android:autoVerify="true">[\s\S]*?<data android:scheme="https" android:host="\$\{muxrPairHost\}" android:pathPrefix="\/pair"\/>[\s\S]*?<\/intent-filter>/, 'production manifest lost verified pairing links');
const voiceManifest = readFileSync(join(mobile, 'modules', 'voice-overlay', 'android', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
assert.match(voiceManifest, /FOREGROUND_SERVICE_DATA_SYNC/);
assert.match(voiceManifest, /foregroundServiceType="microphone\|dataSync"/);
assert.equal(existsSync(join(mobile, 'sources', 'app', '(app)', 'settings', 'account.tsx')), false, 'stale hosted-account screen is still shipped');
for (const path of [
    join(mobile, 'sources', 'app', '(app)', '_layout.tsx'),
    join(mobile, 'sources', 'settings', 'presentation', 'SettingsView.tsx'),
    join(mobile, 'sources', 'components', 'CommandPalette', 'CommandPaletteProvider.tsx'),
]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /settings\/account|Account and preferences|Email, hosted status|Manage your account/, `${path} still exposes hosted-account UX`);
}

for (const path of [join(root, 'package.json'), join(mobile, 'package.json')]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /revenuecat|react-native-purchases/i, `${path} still declares native/store commerce`);
}

process.stdout.write('mobile build policy passed: store has no commerce; direct distribution remains explicit\n');
