import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
assert.equal(eas.build.production.env.MUXR_ANDROID_APPLICATION_ID, 'com.trymuxr.app');
assert.equal(eas.build.production.env.ORG_GRADLE_PROJECT_reactNativeArchitectures, 'arm64-v8a');
assert.match(readFileSync(join(mobile, 'android', 'app', 'build.gradle'), 'utf8'), /MUXR_ANDROID_APPLICATION_ID/);

for (const path of [join(root, 'package.json'), join(mobile, 'package.json')]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /revenuecat|react-native-purchases/i, `${path} still declares native/store commerce`);
}

process.stdout.write('mobile build policy passed: store has no commerce; direct distribution remains explicit\n');
