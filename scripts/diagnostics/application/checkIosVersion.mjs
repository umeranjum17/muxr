/**
 * The iOS app reports CFBundleShortVersionString, which a direct xcodebuild of
 * the checked-in project takes from its MARKETING_VERSION without running
 * prebuild. app.config.js is the one source for that version and the build
 * number, so the checked-in project must carry the same values on every target
 * and configuration (the embedded Live Activity must match its app), or the app
 * shows a version it was not built from and Settings warns of a false mismatch.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mobile = join(process.cwd(), 'apps', 'mobile');
const config = JSON.parse(execFileSync('npx', ['expo', 'config', '--json', '--type', 'public'], { cwd: mobile, encoding: 'utf8' }));
const project = readFileSync(join(mobile, 'ios', 'muxr.xcodeproj', 'project.pbxproj'), 'utf8');

const wrong = [];
for (const [setting, expected] of [['MARKETING_VERSION', config.version], ['CURRENT_PROJECT_VERSION', config.ios.buildNumber]]) {
    const values = [...project.matchAll(new RegExp(`\\b${setting} = "?([^";]+)"?;`, 'g'))].map((match) => match[1]);
    if (values.length === 0) wrong.push(`${setting} is missing`);
    for (const value of new Set(values)) {
        if (value !== expected) wrong.push(`${setting} is ${value}, app.config.js says ${expected}`);
    }
}
if (wrong.length > 0) {
    process.stderr.write(`apps/mobile/ios/muxr.xcodeproj/project.pbxproj differs from app.config.js:\n  ${wrong.join('\n  ')}\n`);
    process.exit(1);
}
process.stdout.write(`iOS project version ${config.version} (${config.ios.buildNumber}) matches app.config.js\n`);
