/** Explicit Developer ID release. Never used by the ad-hoc macOS build. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Run the Developer ID release on a Mac.');
const appDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const root = join(appDir, '..', '..');
const credentials = join(homedir(), '.muxr');
const env = {
    ...process.env,
    APPLE_API_KEY: process.env.APPLE_API_KEY || join(credentials, 'asc-key.p8'),
    APPLE_API_KEY_ID: process.env.APPLE_API_KEY_ID || readFileSync(join(credentials, 'asc-key-id'), 'utf8').trim(),
    APPLE_API_ISSUER: process.env.APPLE_API_ISSUER || readFileSync(join(credentials, 'asc-issuer-id'), 'utf8').trim(),
    CSC_IDENTITY_AUTO_DISCOVERY: 'true',
};
// API-only: never fall back to an Apple ID password or imported signing key.
for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_KEYCHAIN_PROFILE', 'CSC_LINK', 'DEBUG']) delete env[key];
if (!env.APPLE_API_KEY_ID || !env.APPLE_API_ISSUER) throw new Error('App Store Connect API metadata is empty.');
const privateKey = readFileSync(env.APPLE_API_KEY, 'utf8');
const redact = text => [privateKey, env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER]
    .reduce((result, secret) => result.replaceAll(secret, '[withheld]'), text);
function run(command, args, { quiet = false } = {}) {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 45 * 60 * 1000 });
    if (!quiet || result.status !== 0) process.stdout.write(redact(`${result.stdout ?? ''}${result.stderr ?? ''}`));
    if (result.error) throw new Error(`${command}: ${redact(result.error.message)}`);
    if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status}, signal ${result.signal ?? 'none'}).`);
    return result.stdout;
}
const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'], { quiet: true });
if (!identities.includes('Developer ID Application:')) {
    throw new Error('No usable Developer ID Application identity. The Account Holder must create it with its matching private key on this Mac.');
}
// electron-builder signs nested code with --options runtime, notarizes the app
// with notarytool submit --wait, and staples it BEFORE building the DMG.
run('yarn', ['build']);
run(process.execPath, ['apps/desktop/scripts/build.mjs', '--package', '--mac', '--developer-id']);
const { version } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const app = join(appDir, 'release', 'mac-arm64', 'muxr.app');
const dmg = join(appDir, 'release', `muxr-${version}-mac-arm64.dmg`);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
run('codesign', ['-dv', '--verbose=4', app]);
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '-vv', app]);
// Notarize and staple the outer download too, not just the enclosed app.
const submitted = JSON.parse(run('xcrun', ['notarytool', 'submit', dmg,
    '--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID,
    '--issuer', env.APPLE_API_ISSUER, '--wait', '--output-format', 'json']));
if (submitted.status !== 'Accepted') throw new Error(`Apple rejected the DMG: ${submitted.status}. Inspect the notarytool submission log.`);
run('xcrun', ['stapler', 'staple', dmg]);
run('xcrun', ['stapler', 'validate', dmg]);
run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmg]);
process.stdout.write('Developer ID release passed: signed, notarized and stapled app and DMG.\n');
