/**
 * Full local suite. One command, one exit code.
 * Every check runs even if an earlier one fails, so a single run reports
 * everything that is broken rather than only the first thing.
 *
 * `--fast` runs only the lane a pull request validates automatically. It is the
 * same list in both places on purpose: a fast lane described in YAML drifts
 * from the one developers can run, and then nobody knows what green means.
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
    ['unit: host domain (unread/attention/restart)', 'node', ['apps/host/dist/agent/infrastructure/watchStores.selfCheck.js']],
    ['unit: contract vocabulary round-trip', 'node', ['packages/contract/dist/selfCheck.js']],
    ['policy: plugin bridge types in RequestMap', 'node', ['scripts/diagnostics/application/checkPluginBridge.mjs']],
    ['policy: package architecture (module boundaries, domain purity, no nested ternaries)', 'node', ['packages/checkArchitecture.mjs']],
    ['policy: bundled plugin manifests', 'node', ['scripts/diagnostics/application/checkBundledPlugins.mjs']],
    ['policy: terminal text face is bundled and monospaced', 'node', ['scripts/diagnostics/application/checkTerminalFont.mjs']],
    ['unit: relay pairing (expiry, cap, validation)', 'node', ['apps/relay/dist/selfCheck.js']],
    ['unit: layout snapshot round-trip', 'node', ['apps/host/dist/agent/infrastructure/layoutSelfCheck.js']],
    ['unit: setup domain (pairing/connection/crypto)', 'node', ['scripts/setup/domain/dist/selfCheck.js']],
    ['policy: host/relay architecture', 'npx', ['vitest', 'run', 'apps/host/src/architecture.test.ts', 'apps/relay/src/architecture.test.ts']],
    ['unit: all vitest flows', 'npx', ['vitest', 'run', '--root', '.']],
    // The perf/lib tests are node:test, not vitest (perf/** is excluded from
    // the sweep above), so only this step runs them. Without the muxr.code
    // add-on checkout the warm-probe flow skips loudly instead of passing.
    ['unit: perf gate (gesture metrics, warm-probe gates, node --test)', 'node', ['--test', 'perf/lib/gestureMetrics.test.mjs', 'perf/lib/surfaceProbe.test.mjs']],
    ['policy: mobile architecture', 'npx', ['vitest', 'run', 'apps/mobile/sources/architecture.spec.ts', '--config', 'apps/mobile/vitest.config.ts']],
    ['policy: store/direct mobile commerce builds', 'node', ['scripts/diagnostics/application/checkMobileCommerceBuilds.mjs']],
    ['e2e: device pairing through relay', 'node', ['scripts/diagnostics/application/checkPairing.mjs']],
    ['e2e: durable self-host device revocation', 'node', ['scripts/diagnostics/application/checkSelfhostRevocation.mjs']],
    ['e2e: self-host web push (device auth, levels, revoke)', 'node', ['scripts/diagnostics/application/checkWebPush.mjs']],
    ['e2e: shared remote relay isolation', 'node', ['scripts/diagnostics/application/checkRemoteRelay.mjs']],
    ['e2e: multi-provider usage aggregation', 'node', ['scripts/diagnostics/application/checkUsageStatus.mjs']],
    ['e2e: tailscale ingress ownership', 'node', ['scripts/diagnostics/application/checkTailscaleIngress.mjs']],
    ['unit: selfhost state survives garbage JSON', 'node', ['scripts/diagnostics/application/checkSelfhostState.mjs']],
    ['e2e: voice plugin secret lifecycle', 'node', ['scripts/diagnostics/application/checkVoicePlugin.mjs']],
    ['e2e: strict auth (local fixture exposure)', 'node', ['scripts/diagnostics/application/checkStrictAuth.mjs']],
    ['e2e: second host retires the first', 'node', ['scripts/diagnostics/application/checkHostTakeover.mjs']],
    ['e2e: wire + RPC (all event types)', 'node', ['scripts/diagnostics/application/runSkeletonCheck.mjs']],
    ['e2e: graphical takeover tunnel', 'node', ['scripts/diagnostics/application/checkPreviewTunnel.mjs']],
    ['e2e: herdr backend loop (live server)', 'node', ['scripts/diagnostics/application/checkHerdrE2E.mjs'], 'herdr', 180000],
    ['e2e: worktree session (live stack)', 'node', ['scripts/diagnostics/application/checkWorktreeE2E.mjs'], 'herdr'],
    ['package: curl installer wrapper', 'node', ['scripts/diagnostics/application/checkInstallScript.mjs']],
    // The lifecycle flow needs a packed tree, so the package smoke drives it
    // against its own snapshot instead of a second entry against the root.
    ['package: install/setup + full lifecycle smoke', 'node', ['scripts/diagnostics/application/checkPackageSmoke.mjs'], undefined, 300000],
    ['release: public channel catalog flow', 'node', ['scripts/diagnostics/application/checkReleaseCatalog.mjs']],
    ['policy: core purity (no cloud refs in OSS)', 'node', ['scripts/diagnostics/application/checkCorePurity.mjs']],
    ['policy: tooling architecture (feature boundaries, layers, no nested ternaries)', 'node', ['scripts/diagnostics/application/checkArchitecture.mjs']],
    ['package: web export (manifest, MIME, cache, secrets, budget)', 'node', ['scripts/diagnostics/application/checkWebExport.mjs']],
    ['e2e: web serving delivery (live relay + static server)', 'node', ['scripts/diagnostics/application/checkWebServing.mjs']],
    ['security: export chain isolation (canary export + full scan)', 'node', ['scripts/diagnostics/application/checkExportIsolation.mjs'], undefined, 420000],
    ['security: tracked/package secret scan', 'node', ['scripts/diagnostics/application/checkNoSecrets.mjs']],
];

/**
 * The fast lane: typecheck, the compiled self-checks, every vitest flow, and
 * the architecture policies. Nothing here packs a tarball, exports the web
 * build, or drives an install, so it finishes in about a minute.
 *
 * Deliberately absent: the package/install smoke, the web export and serving
 * checks, the export-chain scan, and the live-herdr e2e. Those still run in the
 * full suite -- the fast lane is early feedback, not a release gate.
 */
const FAST = new Set([
    'typecheck: workspace (strict)',
    'typecheck: mobile (expo/RN)',
    'unit: crypto (strict v2/replay/grants/adversarial)',
    'unit: host domain (unread/attention/restart)',
    'unit: contract vocabulary round-trip',
    'unit: relay pairing (expiry, cap, validation)',
    'unit: layout snapshot round-trip',
    'unit: setup domain (pairing/connection/crypto)',
    'unit: all vitest flows',
    'unit: perf gate (gesture metrics, warm-probe gates, node --test)',
    'policy: host/relay architecture',
    'policy: mobile architecture',
    'policy: package architecture (module boundaries, domain purity, no nested ternaries)',
    'policy: tooling architecture (feature boundaries, layers, no nested ternaries)',
]);

const fastOnly = process.argv.includes('--fast');
// A renamed check must not fall out of the fast lane in silence; that is how a
// pull request ends up green having validated less than anyone thinks.
const missing = [...FAST].filter((name) => !checks.some(([existing]) => existing === name));
if (missing.length > 0) {
    process.stderr.write(`fast lane names no longer in the suite:\n  ${missing.join('\n  ')}\n`);
    process.exit(1);
}

const results = [];

function run(name, cmd, args, timeoutMs = 150000) {
    return new Promise((resolve) => {
        const started = Date.now();
        // A live deployment exports these. Inherited, they make every check
        // point a real token and key at the throwaway relays these checks spawn,
        // which then refuse the host -- failures that look like code regressions.
        // RELAY_PORT is worse than that: it aims a check at a relay it did not
        // start, which is how a check goes green having tested nothing.
        const env = { ...process.env };
        for (const key of ['RELAY_TOKEN', 'RELAY_URL', 'MACHINE_ID', 'RELAY_AUTH', 'RELAY_PORT']) {
            delete env[`MUXR_${key}`];
        }
        if (cmd === 'npx' && args[0] === 'vitest') env.NODE_ENV = 'test';
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

process.stdout.write(`\n=== MUXR SUITE${fastOnly ? ' (fast lane)' : ''} ===\n\n`);
if (!fastOnly && !hasHerdr) {
    process.stdout.write(
        `No herdr socket at ${herdrSocket}.\n`
        + `Skipping the live-herdr check. Run \`herdr server\` to enable it.\n\n`,
    );
}
let skipped = 0;
for (const [name, cmd, args, needs, timeoutMs] of checks) {
    if (fastOnly && !FAST.has(name)) continue;
    if (needs === 'herdr' && !hasHerdr) {
        skipped += 1;
        process.stdout.write(`SKIP  ${name}  (no herdr server)\n`);
        continue;
    }
    // No settle wait between checks: every relay they spawn now takes a
    // kernel-picked port, so nothing is left holding a number the next one needs.
    await run(name, cmd, args, timeoutMs);
}

const failed = results.filter((r) => r.code !== 0);
const total = (results.reduce((sum, r) => sum + r.ms, 0) / 1000).toFixed(1);
const skipNote = skipped > 0 ? `, ${skipped} skipped (no herdr server)` : '';
process.stdout.write(`\n=== ${results.length - failed.length}/${results.length} passed in ${total}s${skipNote} ===\n`);
if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((r) => r.name).join(', ')}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
