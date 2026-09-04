// Run in a dedicated shell pane. This builds a release variant with a test signer.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { patchedDependencies, sha256, sourceIdentity } from './lib/provenance.mjs';

const out = resolve(process.argv[2] ?? '/tmp/muxr-pr-build');
mkdirSync(out, { recursive: true });
const source = sourceIdentity();
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const versionCode = process.env.ANDROID_VERSION_CODE ?? execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[1-9]\d*$/.test(versionCode)) throw new Error('Invalid app version/version code');
const run = (bin, args, options = {}) => execFileSync(bin, args, { stdio: 'inherit', timeout: 45 * 60_000, ...options });
if (existsSync('node_modules') && realpathSync('node_modules') !== resolve('node_modules')) throw new Error('Build needs private node_modules; refusing to modify a shared symlink');
// --force restores package files before postinstall reapplies this revision's
// patches. A copied dependency tree may contain another branch's native patch.
run('yarn', ['install', '--frozen-lockfile', '--non-interactive', '--force']);
run(process.execPath, ['scripts/diagnostics/application/verifyNativePatches.mjs']);
const nativeDependencies = patchedDependencies();
run('yarn', ['build']);
const keystore = resolve(out, 'test.keystore');
if (!existsSync(keystore)) run('keytool', ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-dname', 'CN=Emulator PR Gate', '-keyalg', 'RSA', '-validity', '3650']);
run('./gradlew', ['app:assembleRelease', '--no-daemon', '--max-workers=4', '-PreactNativeArchitectures=x86_64',
    `-PappVersion=${version}`, `-PandroidVersionCode=${versionCode}`,
    `-PreleaseStoreFile=${keystore}`,
    '-PreleaseStorePassword=android', '-PreleaseKeyAlias=androiddebugkey', '-PreleaseKeyPassword=android'],
{ cwd: 'apps/mobile/android', env: { ...process.env, NODE_ENV: 'production', APP_ENV: 'production', MUXR_PUBLIC_BASE_URL: 'https://trymuxr.com', MUXR_DISTRIBUTION: 'store' } });
if (sourceIdentity().sourceSha256 !== source.sourceSha256) throw new Error('Sources changed during build; rebuild before claiming provenance');
const apk = resolve(out, 'app-release.apk');
copyFileSync('apps/mobile/android/app/build/outputs/apk/release/app-release.apk', apk);
if (JSON.stringify(patchedDependencies()) !== JSON.stringify(nativeDependencies)) throw new Error('Patched dependencies changed during build');
writeFileSync(`${apk}.json`, JSON.stringify({ ...source, nativeDependencies, apkSha256: sha256(apk), variant: 'release', signer: 'Android test key (not store signing)', builtAt: new Date().toISOString() }, null, 2));
console.log(`APK and provenance: ${apk}`);
