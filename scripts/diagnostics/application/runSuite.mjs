/**
 * Full local suite. One command, one exit code.
 * Every check runs even if an earlier one fails, so a single run reports
 * everything that is broken rather than only the first thing.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The herdr check drives a live herdr server through the real host. Without one
// it burns its timeout and reports a misleading failure, so detect and skip.
const herdrSocket = process.env.HERDR_SOCKET_PATH?.trim()
    || join(process.env.HOME?.trim() || homedir(), '.config', 'herdr', 'herdr.sock');
const hasHerdr = existsSync(herdrSocket);

const checks = [
    ['typecheck: workspace (strict)', 'npx', ['tsc', '--build', '--force']],
    ['typecheck: mobile (expo/RN)', 'npx', ['tsc', '--noEmit', '--project', 'apps/mobile/tsconfig.json']],
    ['unit: crypto (strict v2/replay/grants/adversarial)', 'node', ['packages/crypto/dist/selfCheck.js']],
    ['unit: host domain (unread/attention/restart)', 'node', ['apps/host/dist/domain/selfCheck.js']],
    ['unit: contract vocabulary round-trip', 'node', ['packages/contract/dist/selfCheck.js']],
    ['policy: plugin bridge types in RequestMap', 'node', ['scripts/diagnostics/application/checkPluginBridge.mjs']],
    ['policy: package architecture (contexts, use cases, no nested ternaries)', 'node', ['packages/checkArchitecture.mjs']],
    ['policy: bundled plugin manifests', 'node', ['scripts/diagnostics/application/checkBundledPlugins.mjs']],
    ['unit: relay pairing (expiry, cap, validation)', 'node', ['apps/relay/dist/selfCheck.js']],
    ['unit: layout snapshot round-trip', 'node', ['apps/host/dist/herdr/layoutSelfCheck.js']],
    ['unit: setup domain (pairing/connection/crypto)', 'node', ['scripts/setup/domain/dist/selfCheck.js']],
    ['unit: all vitest flows', 'npx', ['vitest', 'run', '--root', '.']],
    ['policy: mobile architecture', 'npx', ['vitest', 'run', 'apps/mobile/sources/architecture.spec.ts', '--config', 'apps/mobile/vitest.config.ts']],
    ['policy: store/direct mobile commerce builds', 'node', ['scripts/diagnostics/application/checkMobileCommerceBuilds.mjs']],
    ['e2e: device pairing through relay', 'node', ['scripts/diagnostics/application/checkPairing.mjs']],
    ['e2e: durable self-host device revocation', 'node', ['scripts/diagnostics/application/checkSelfhostRevocation.mjs']],
    ['e2e: shared remote relay isolation', 'node', ['scripts/diagnostics/application/checkRemoteRelay.mjs']],
    ['e2e: multi-provider usage aggregation', 'node', ['scripts/diagnostics/application/checkUsageStatus.mjs']],
    ['e2e: tailscale ingress ownership', 'node', ['scripts/diagnostics/application/checkTailscaleIngress.mjs']],
    ['unit: selfhost state survives garbage JSON', 'node', ['scripts/diagnostics/application/checkSelfhostState.mjs']],
    ['e2e: voice plugin secret lifecycle', 'node', ['scripts/diagnostics/application/checkVoicePlugin.mjs']],
    ['e2e: strict auth (local fixture exposure)', 'node', ['scripts/diagnostics/application/checkStrictAuth.mjs']],
    ['e2e: second host retires the first', 'node', ['scripts/diagnostics/application/checkHostTakeover.mjs']],
    ['e2e: wire + RPC (all event types)', 'node', ['scripts/diagnostics/application/runSkeletonCheck.mjs']],
    ['e2e: browser preview tunnel', 'node', ['scripts/diagnostics/application/checkPreviewTunnel.mjs']],
    ['e2e: herdr backend loop (live server)', 'node', ['scripts/diagnostics/application/checkHerdrE2E.mjs'], 'herdr', 180000],
    ['e2e: worktree session (live stack)', 'node', ['scripts/diagnostics/application/checkWorktreeE2E.mjs'], 'herdr'],
    ['package: curl installer wrapper', 'node', ['scripts/diagnostics/application/checkInstallScript.mjs']],
    ['package: host-only install/setup smoke', 'node', ['scripts/diagnostics/application/checkPackageSmoke.mjs'], undefined, 300000],
    ['package: full lifecycle smoke', 'node', ['scripts/diagnostics/application/packageLifecycleSmoke.mjs'], undefined, 300000],
    ['policy: core purity (no cloud refs in OSS)', 'node', ['scripts/diagnostics/application/checkCorePurity.mjs']],
    ['policy: tooling architecture (layers, no nested ternaries)', 'node', ['scripts/diagnostics/application/checkArchitecture.mjs']],
    ['security: tracked/package secret scan', 'node', ['scripts/diagnostics/application/checkNoSecrets.mjs']],
];

const results = [];

function run(name, cmd, args, timeoutMs = 150000) {
    return new Promise((resolve) => {
        const started = Date.now();
        // A live deployment exports these. Inherited, they make every check
        // point a real token and key at the throwaway relays these checks spawn,
        // which then refuse the host -- failures that look like code regressions.
        const env = { ...process.env };
        for (const key of ['RELAY_TOKEN', 'RELAY_URL', 'MACHINE_ID', 'RELAY_AUTH']) {
            delete env[`MUXR_${key}`];
        }
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('exit', (code) => {
            clearTimeout(timer);
            const ms = Date.now() - started;
            results.push({ name, code: code ?? 1, ms, out });
            const mark = code === 0 ? 'PASS' : 'FAIL';
            process.stdout.write(`${mark}  ${name}  (${(ms / 1000).toFixed(1)}s)\n`);
            if (code !== 0) {
                const tail = out.trim().split('\n').slice(-12).join('\n      ');
                process.stdout.write(`      ${tail}\n`);
            }
            resolve();
        });
    });
}

process.stdout.write('\n=== MUXR SUITE ===\n\n');
if (!hasHerdr) {
    process.stdout.write(
        `No herdr socket at ${herdrSocket}.\n`
        + `Skipping the live-herdr check. Run \`herdr server\` to enable it.\n\n`,
    );
}
let skipped = 0;
for (const [name, cmd, args, needs, timeoutMs] of checks) {
    if (needs === 'herdr' && !hasHerdr) {
        skipped += 1;
        process.stdout.write(`SKIP  ${name}  (no herdr server)\n`);
        continue;
    }
    await run(name, cmd, args, timeoutMs);
    // e2e checks bind ports; let them release before the next one.
    await new Promise((r) => setTimeout(r, 500));
}

const failed = results.filter((r) => r.code !== 0);
const total = (results.reduce((sum, r) => sum + r.ms, 0) / 1000).toFixed(1);
const skipNote = skipped > 0 ? `, ${skipped} skipped (no herdr server)` : '';
process.stdout.write(`\n=== ${results.length - failed.length}/${results.length} passed in ${total}s${skipNote} ===\n`);
if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((r) => r.name).join(', ')}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
