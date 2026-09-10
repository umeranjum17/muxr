/**
 * Clean-environment Herdr-plugin onboarding gate.
 *
 * Certifies the muxr.control plugin onboarding loop through the REAL Herdr
 * mechanism in an isolated container (clean HOME, non-root user, own Herdr
 * server, real PTYs, real systemd user supervision) — never by invoking
 * plugin scripts directly:
 *
 *   install from source @ pinned ref -> build hook pins the exact CLI
 *   (no sudo) -> missing payload errors -> unconfigured startup is a no-op
 *   -> setup pane opens -> review+cancel changes nothing -> apply LAN
 *   config -> real user service supervises relay+host -> health, pairing
 *   material, socket persistence -> unchanged reapply -> failure matrix
 *   (malformed config, occupied port, dead service must never say complete)
 *   -> browser-loopback gating -> update-check/unlink ownership.
 *
 * What this gate does NOT claim: browser client hosting (the product gates
 * it on Tailscale Serve / External WSS / Cloudflare, none of which exist in
 * a clean room — the gate proves the refusal instead), macOS launchd, or a
 * phone completing pairing.
 *
 * Usage:
 *   node scripts/diagnostics/application/checkPluginOnboarding.mjs [--only=a,b] [--keep] [--ref=<sha>]
 *
 * Requires: docker, a systemd-capable image (GATE_IMAGE, default
 * muxr-gate-systemd:1 — build it from the sibling
 * plugin-onboarding-gate.systemd.Dockerfile with a copy of the real local
 * herdr binary in context), network for GitHub/npm. The container runs
 * privileged with the host cgroup namespace so PID 1 is a genuine systemd
 * and `muxr daemon` drives real user units.
 * Exits before any stage when the pinned ref is not fetchable from GitHub
 * (push the candidate first); the previous gate report is left in place.
 * Writes a JSON report to stdout and, when HERDR_PANE_ID is set, to the
 * pane attachments directory.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const IMAGE = process.env.GATE_IMAGE ?? 'muxr-gate-systemd:1';
const SOURCE = 'umeranjum17/muxr/plugins/control';
const CONTAINER = process.env.GATE_CONTAINER ?? `muxr-gate-run-${process.pid}`;
const KEEP = process.argv.includes('--keep');
const ONLY = (process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? '')
    .split(',').map((stage) => stage.trim()).filter((stage) => stage !== '');
const REF_ARG = process.argv.find((arg) => arg.startsWith('--ref='))?.slice('--ref='.length);

function gitHead() {
    const check = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (check.status !== 0) throw new Error('cannot determine checkout HEAD for the plugin ref pin');
    return check.stdout.trim();
}
const REF = process.env.GATE_PLUGIN_REF?.trim() || REF_ARG || gitHead();

const results = [];
function record(stage, ok, detail) {
    results.push({ stage, ok, detail });
    const mark = ok ? 'PASS' : 'FAIL';
    const suffix = detail ? ` — ${detail}` : '';
    process.stdout.write(`gate ${stage}: ${mark}${suffix}\n`);
}

function sh(args, options = {}) {
    const run = spawnSync(args[0], args.slice(1), {
        encoding: 'utf8',
        timeout: options.timeout ?? 60_000,
        ...options.spawn,
    });
    return { status: run.status, signal: run.signal, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

const dock = (args, options) => {
    // Emulate a login session: docker exec provides no pam_systemd, but SSH
    // (the real remote-admin path) sets XDG_RUNTIME_DIR, and user services
    // need it to reach the user bus.
    const session = state.uid === undefined ? [] : ['-e', `XDG_RUNTIME_DIR=/run/user/${state.uid}`];
    return sh(['docker', 'exec', '-u', 'gate', ...session, CONTAINER, ...args], options);
};
const csh = (script, options) => dock(['sh', '-c', script], options);
const cherdr = (args, options) => dock(['herdr', ...args], options);

const state = { uid: undefined, pin: undefined, setupPane: undefined, workspace: undefined, rootPane: undefined, pluginCwd: undefined };

/**
 * Is the pinned plugin ref fetchable from GitHub? Names resolve through
 * ls-remote; raw SHAs are not ref names, so they probe with a shallow
 * fetch — the same transport the installer uses. Returns true (fetchable),
 * false (definitely absent — unpushed candidate or unknown ref), or null
 * (network or tooling failure, in which case the install stage remains the
 * backstop instead of blocking the gate on infra flakiness).
 */
function networkFailed(output) {
    return /could not resolve host|unable to connect|failed to connect|network is unreachable|timed out|connection refused/i.test(output);
}

const gitAt = (args, options) => sh(['git', ...args], { ...options, spawn: { cwd: ROOT } });

function refFetchable(ref) {
    const [owner, repo] = SOURCE.split('/');
    const url = `https://github.com/${owner}/${repo}.git`;
    // Resolve the ref to a commit. A remotely existing name is fetchable by
    // name; anything else must be an ancestor of an advertised tip (raw SHAs
    // are not ref names, and anonymous SHA fetch is refused server-side, so
    // only reachability proves a clean-room installer can obtain it).
    let commit = /^[0-9a-f]{40,64}$/i.test(ref) ? ref.toLowerCase() : null;
    if (commit === null) {
        const local = gitAt(['rev-parse', '--verify', `${ref}^{commit}`], { timeout: 15_000 });
        if (local.status === 0) {
            commit = local.stdout.trim();
        } else {
            const remote = gitAt(['ls-remote', url, ref], { timeout: 30_000 });
            if (remote.status !== 0) return networkFailed(`${remote.stdout}\n${remote.stderr}`) ? null : false;
            return remote.stdout.trim() !== '';
        }
    }
    const tips = gitAt(['ls-remote', url], { timeout: 60_000 });
    if (tips.status !== 0) return networkFailed(`${tips.stdout}\n${tips.stderr}`) ? null : false;
    for (const line of tips.stdout.split('\n')) {
        const tip = line.split(/\s+/)[0] ?? '';
        if (!/^[0-9a-f]{40}$/.test(tip)) continue;
        if (gitAt(['cat-file', '-e', tip], { timeout: 15_000 }).status !== 0) continue;
        if (gitAt(['merge-base', '--is-ancestor', commit, tip], { timeout: 15_000 }).status === 0) return true;
    }
    return false;
}

const fetchable = refFetchable(REF);
if (fetchable === false) {
    process.stderr.write(`gate preflight: plugin ref ${REF} is not fetchable from GitHub (unpushed candidate or unknown ref) — push the candidate first, then rerun. No stages ran; the previous gate report is retained.\n`);
    process.exit(1);
}
if (fetchable === null) {
    process.stdout.write(`gate preflight: could not verify plugin ref ${REF} (network/tooling); continuing, install remains the backstop\n`);
}

/** Start the container herdr server headless (real mechanism, not the TUI). */
function startHerdrServer() {
    csh(`mkdir -p .config/herdr && setsid nohup herdr server >.config/herdr/gate-server.log 2>&1 < /dev/null & sleep 4`);
    const status = cherdr(['status'], { timeout: 30_000 });
    if (!status.stdout.includes('status: running')) {
        throw new Error(`container herdr server did not start: ${status.stdout.slice(0, 200)}`);
    }
}

function userEnv(args, options) {
    assert(state.uid !== undefined, 'container uid unknown');
    return sh(['docker', 'exec', '-u', 'gate', '-e', `XDG_RUNTIME_DIR=/run/user/${state.uid}`, CONTAINER, ...args], options);
}
const sysctl = (args, options) => userEnv(['systemctl', '--user', ...args], options);

/** Container herdr pane text. */
function paneText(paneId) {
    const read = cherdr(['pane', 'read', paneId, '--source', 'visible', '--format', 'text'], { timeout: 30_000 });
    return read.stdout;
}

function paneGone(paneId) {
    const get = cherdr(['pane', 'get', paneId], { timeout: 30_000 });
    return get.stdout.includes('pane_not_found') || get.stderr.includes('pane_not_found');
}

function sleep(seconds) {
    sh(['sleep', String(seconds)], { timeout: (seconds + 5) * 1000 });
}

/**
 * Drive an interactive pane through an adaptive script: each poll fires the
 * first unfinished step whose pattern matches, so fresh-apply and
 * reapply (port prompt, keep-devices choice) share one script.
 */
/**
 * Drive an interactive pane through an adaptive script. Prompts share one
 * shape ("...or b to cancel setup:" with nothing after it), so a step fires
 * only on a fresh prompt -- echoed answers in scrollback never refire.
 * `repeat` steps (the per-add-on screens, whose count varies) stay armed
 * until every required step is done.
 */
const FRESH_PROMPT = /or b to cancel setup:\s*$/m;

function driveSetup(paneId, script, timeoutMs = 180_000) {
    const start = Date.now();
    const done = new Array(script.length).fill(false);
    const required = script.map((step) => step.optional !== true && step.repeat !== true);
    let lastText = '';
    const pending = () => done.findIndex((flag, index) => !flag && required[index]);
    while (pending() !== -1) {
        if (Date.now() - start > timeoutMs) {
            const index = pending();
            throw new Error(`setup drive timed out at step ${index} (${script[index].send}): ${lastText.slice(-3000)}`);
        }
        if (paneGone(paneId)) {
            throw new Error(`setup pane closed with steps unfinished [${done.map((flag) => flag ? 'x' : '.').join('')}]: ${lastText.slice(-3000)}`);
        }
        const text = paneText(paneId);
        lastText = text;
        // The free-text port prompt ("›") carries no fresh suffix; every
        // other prompt shares the choose-or-cancel shape.
        const fresh = FRESH_PROMPT.test(text);
        for (let index = 0; index < script.length; index += 1) {
            const step = script[index];
            if (done[index] || !step.pattern.test(text)) continue;
            if (step.raw !== true && !fresh) continue;
            cherdr(['pane', 'run', paneId, step.send], { timeout: 30_000 });
            if (step.repeat !== true) done[index] = true;
            break;
        }
        sleep(2);
    }
}

/** Wait for a setup pane to finish: exits, or parks on its pairing screen. */
function awaitSetupDone(paneId, timeoutMs = 240_000) {
    const start = Date.now();
    let last = '';
    for (;;) {
        if (paneGone(paneId)) return last;
        last = paneText(paneId);
        if (/pairing QR|scan .* pair|setup complete/i.test(last)) return last;
        if (Date.now() - start > timeoutMs) throw new Error('setup did not finish');
        sleep(5);
    }
}

function openSetupPane() {
    // Headless servers have no focused workspace for a pane to land in.
    if (state.workspace === undefined) {
        const created = cherdr(['workspace', 'create', '--cwd', '/home/gate', '--label', 'gate', '--no-focus'], { timeout: 60_000 });
        const workspaceId = /"workspace_id":"([^"]+)"/.exec(created.stdout)?.[1];
        if (workspaceId === undefined) throw new Error(`workspace create failed: ${created.stdout.slice(0, 200)}`);
        state.workspace = workspaceId;
        // First pane_id in the response is the workspace root pane.
        const rootPane = /"pane_id":"(w\d+:p\d+)"/.exec(created.stdout)?.[1];
        if (rootPane === undefined) throw new Error('workspace root pane unknown');
        state.rootPane = rootPane;
    }
    const open = cherdr(['plugin', 'pane', 'open', '--plugin', 'muxr.control', '--entrypoint', 'setup', '--placement', 'tab', '--workspace', state.workspace], { timeout: 60_000 });
    const paneId = /"pane_id":"([^"]+)"/.exec(open.stdout)?.[1];
    if (paneId === undefined) throw new Error(`setup pane did not open: ${open.stdout.slice(0, 200)} ${open.stderr.slice(0, 200)}`);
    const cwd = /"cwd":"([^"]+)"/.exec(open.stdout)?.[1];
    if (cwd !== undefined) state.pluginCwd = cwd;
    return paneId;
}

function waitForPrompt(paneId, pattern, timeoutMs = 90_000) {
    const start = Date.now();
    let text = '';
    while (!pattern.test(text)) {
        if (Date.now() - start > timeoutMs) throw new Error(`prompt never appeared: ${pattern}`);
        if (paneGone(paneId)) throw new Error('setup pane closed while waiting for prompt');
        sleep(3);
        text = paneText(paneId);
    }
    return text;
}

function cleanup() {
    if (KEEP) {
        process.stdout.write(`gate cleanup: keeping container ${CONTAINER} (--keep)\n`);
        return;
    }
    sh(['docker', 'rm', '-f', CONTAINER], { timeout: 60_000 });
}

let failed = false;
function stage(name, fn) {
    if (ONLY.length > 0 && !ONLY.includes(name)) {
        process.stdout.write(`gate ${name}: SKIP (--only)\n`);
        return undefined;
    }
    try {
        const detail = fn();
        record(name, true, detail);
        return detail;
    } catch (error) {
        failed = true;
        record(name, false, error instanceof Error ? error.message : String(error));
        return undefined;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

process.on('uncaughtException', (error) => {
    record('harness', false, error instanceof Error ? error.message : String(error));
    cleanup();
    process.exit(1);
});

const APPLY_FRESH = [
    { pattern: /Choose how your phone connects/, send: '3' },
    { pattern: /Local connection port/, send: '8792', raw: true, optional: true },
    { pattern: /Connect your coding agents/, send: '2' },
    { pattern: /Pair a client\?/, send: '1', optional: true },
    { pattern: /◆ (?:Optional Herdr add-ons|Add [^\n]*\?)[\s\S]{0,900}Choose 1-2 \(1\), or b to cancel setup:\s*$/, send: '1', repeat: true },
    { pattern: /Apply this setup\?/, send: '2' },
];

const APPLY_RE = [
    { pattern: /Choose how your phone connects/, send: '3' },
    { pattern: /Local connection port/, send: '8792', raw: true },
    { pattern: /Pair a client\?/, send: '1' },
    { pattern: /Connect your coding agents/, send: '2' },
    { pattern: /◆ (?:Optional Herdr add-ons|Add [^\n]*\?)[\s\S]{0,900}Choose 1-2 \(1\), or b to cancel setup:\s*$/, send: '1', repeat: true },
    { pattern: /Apply this setup\?/, send: '2' },
];

// --- stages ---------------------------------------------------------------

stage('preflight', () => {
    const docker = sh(['docker', '--version'], { timeout: 15_000 });
    assert(docker.status === 0, 'docker is unavailable');
    const image = sh(['docker', 'images', '-q', IMAGE], { timeout: 15_000 });
    assert(image.stdout.trim() !== '', `image ${IMAGE} missing; build it first`);
    return `docker ok, image ${IMAGE}, plugin ref ${REF}`;
});

stage('container', () => {
    // Privileged with the host cgroup namespace: PID 1 must be a genuine
    // systemd for the user service manager to exist (a cgroup bind-mount
    // instead makes systemd bail silently on cgroup2 hosts).
    const run = sh([
        'docker', 'run', '-d', '--name', CONTAINER, '--hostname', 'muxr-gate',
        '--privileged', '--cgroupns=host', IMAGE,
    ], { timeout: 60_000 });
    assert(run.status === 0, `docker run failed: ${run.stderr.slice(0, 200)}`);
    const who = csh('whoami; id -u gate; test -n "$SUDO_USER$SUDO_UID" && echo SUDO-LEAK || echo no-sudo-env');
    assert(who.stdout.includes('gate'), 'container user is not gate');
    assert(who.stdout.includes('no-sudo-env'), 'sudo env leaked into container');
    state.uid = /id -u gate\s*\n(\d+)/.exec(who.stdout)?.[1] ?? csh('id -u gate').stdout.trim();
    assert(/^\d+$/.test(state.uid), 'cannot read gate uid');
    // Bare `herdr` starts the server (the TUI itself panics headless, which is fine).
    startHerdrServer();
    const status = cherdr(['status'], { timeout: 30_000 });
    assert(status.stdout.includes('status: running'), 'container herdr server did not start');
    const pid1 = csh('ps -p 1 -o comm=');
    assert(pid1.stdout.trim() === 'systemd', `PID 1 is ${pid1.stdout.trim()}, not systemd`);
    const clean = csh('test -e .muxr && echo DIRTY || echo CLEAN');
    assert(clean.stdout.includes('CLEAN'), 'container HOME is not clean');
    return `privileged systemd container, non-root, server up, HOME clean`;
});

stage('install', () => {
    const install = cherdr(['plugin', 'install', SOURCE, '--ref', REF, '-y'], { timeout: 420_000 });
    const output = `${install.stdout}\n${install.stderr}`;
    assert(install.status === 0 && output.includes('Installed muxr.control'), `plugin install failed: ${output.slice(-500)}`);
    const list = cherdr(['plugin', 'list'], { timeout: 30_000 });
    assert(list.stdout.includes('muxr.control'), 'muxr.control missing from plugin list');
    return `muxr.control installed @ ${REF.slice(0, 12)}`;
});

stage('build-pin', () => {
    // The pin is whatever checkout the installed plugin ships in.
    const root = csh('ls -d .config/herdr/plugins/github/*/ | head -1');
    const checkout = root.stdout.trim();
    assert(checkout !== '', 'installed plugin checkout not found');
    const manifest = csh(`node -e "console.log(JSON.parse(require('fs').readFileSync('${checkout}package.json','utf8')).version)"`);
    const pin = manifest.stdout.trim();
    assert(/^\d+\.\d+\.\d+/.test(pin), `unreadable pin in ${checkout}package.json`);
    state.pin = pin;
    const runtime = csh('stat -c "%a %U" .muxr/herdr-plugin.runtime; cat .muxr/herdr-plugin.runtime');
    assert(runtime.stdout.startsWith('600 gate'), `runtime not owner-only: ${runtime.stdout.split('\n')[0]}`);
    const recorded = JSON.parse(runtime.stdout.split('\n').slice(1).join('\n'));
    assert(recorded.version === pin, `recorded ${recorded.version} != pin ${pin}`);
    const version = dock(['muxr', 'version'], { timeout: 30_000 });
    assert(version.stdout.trim().split('\n').pop() === pin, `muxr on PATH is not ${pin}`);
    return `exact pin ${pin}, runtime 0600, no sudo`;
});

stage('fail-payload', () => {
    // Before apply the GitHub-installed shim is live, so hiding the payload
    // must break the setup command loudly instead of completing anything. The
    // overlay closes too fast to read, so run the declared pane command
    // (`node ./run.mjs setup`, plugin cwd) in the persistent root pane: same
    // command, same PTY machinery, durable output.
    csh('mv .npm-global/bin/muxr /tmp/muxr.hidden; rm -f .muxr/herdr-plugin.runtime');
    try {
        openSetupPane();
        assert(state.rootPane !== undefined && state.pluginCwd !== undefined, 'workspace or plugin cwd unknown');
        cherdr(['pane', 'run', state.rootPane, `cd ${state.pluginCwd} && node ./run.mjs setup; echo PAYLOAD-RC=$?`], { timeout: 60_000 });
        sleep(8);
        const text = paneText(state.rootPane);
        assert(/no muxr runtime/i.test(text), `missing payload shows no error: ${text.slice(-300)}`);
        assert(/PAYLOAD-RC=[1-9]/.test(text), 'missing payload exited zero');
        assert(!/pairing QR|setup complete/i.test(text), 'missing payload looks complete');
    } finally {
        csh('mv /tmp/muxr.hidden .npm-global/bin/muxr');
    }
    const version = dock(['muxr', 'version'], { timeout: 30_000 });
    assert(version.stdout.trim().split('\n').pop() === state.pin, 'payload restore failed');
    return 'missing payload errors via the real command, never completes';
});

stage('startup-noop', () => {
    cherdr(['server', 'stop'], { timeout: 60_000 });
    startHerdrServer();
    const status = cherdr(['status'], { timeout: 30_000 });
    assert(status.stdout.includes('status: running'), 'server did not restart');
    const logs = cherdr(['plugin', 'log', 'list'], { timeout: 30_000 });
    assert(logs.stdout.includes('start-if-configured') && logs.stdout.includes('"exit_code":0'), 'startup hook has no clean record');
    const files = csh('ls .muxr/');
    assert(!files.stdout.includes('selfhost.json'), 'startup created state on an unconfigured machine');
    return 'startup exit 0, no state created';
});

stage('pane-open', () => {
    const paneId = openSetupPane();
    state.setupPane = paneId;
    waitForPrompt(paneId, /Choose how your phone connects/);
    return `setup pane ${paneId} shows the route choice`;
});

stage('cancel-noop', () => {
    assert(state.setupPane !== undefined, 'no setup pane from pane-open');
    cherdr(['pane', 'run', state.setupPane, 'b'], { timeout: 30_000 });
    const start = Date.now();
    while (!paneGone(state.setupPane)) {
        if (Date.now() - start > 60_000) throw new Error('cancelled wizard did not exit');
        sleep(2);
    }
    const files = csh('ls .muxr/');
    assert(!files.stdout.includes('selfhost.json'), 'cancelled setup wrote state');
    return 'review+cancel changed nothing';
});

stage('apply', () => {
    const paneId = openSetupPane();
    driveSetup(paneId, APPLY_FRESH);
    const tail = awaitSetupDone(paneId).slice(-600);
    const files = csh('ls .muxr/; stat -c "%a %n" .muxr/selfhost.json .muxr/setup-manifest.json');
    assert(files.stdout.includes('selfhost.json'), 'apply wrote no config');
    assert(files.stdout.includes('600 .muxr/selfhost.json'), 'selfhost.json is not owner-only');
    const secrets = csh('stat -c "%a %n" .muxr/relay/* 2>/dev/null');
    for (const line of secrets.stdout.trim().split('\n')) {
        if (line.trim() === '') continue;
        assert(line.startsWith('600 '), `secret not 0600: ${line}`);
    }
    const keys = csh(`node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('.muxr/selfhost.json','utf8'))).join(','))"`);
    assert(keys.stdout.includes('relay'), `selfhost.json has no relay provenance: ${keys.stdout}`);
    const bundled = cherdr(['plugin', 'list'], { timeout: 30_000 });
    assert(bundled.stdout.includes('muxr.control'), 'muxr.control missing after apply');
    return `LAN route applied, config 0600, secrets 0600${/pairing QR|scan/i.test(tail) ? ', pairing screen shown' : ''}`;
});

stage('service-supervised', () => {
    const linger = csh('sudo -n /bin/loginctl enable-linger gate && loginctl show-user gate -p Linger 2>/dev/null || echo LINGER-DONE');
    assert(!/failed|error/i.test(linger.stderr), `linger failed: ${linger.stderr.slice(0, 200)}`);
    const start = dock(['muxr', 'daemon', 'start'], { timeout: 120_000 });
    const output = `${start.stdout}\n${start.stderr}`;
    assert(start.status === 0, `daemon start failed (exit ${start.status}): ${output.slice(-1500)}`);
    const active = sysctl(['is-active', 'muxr.service'], { timeout: 30_000 });
    assert(active.stdout.trim() === 'active', `unit not active: ${active.stdout.trim()} ${active.stderr.slice(0, 100)}`);
    const health = csh('curl -s --max-time 3 http://127.0.0.1:8792/health; echo');
    assert(health.stdout.includes('"ok":true'), 'supervised relay does not answer /health');
    const doctor = dock(['muxr', 'doctor'], { timeout: 120_000 });
    assert(!/self-host relay.*not reachable|host service.*not running/i.test(doctor.stdout), `doctor still reports services down:\n${doctor.stdout}`);
    return 'real user unit active, relay healthy, doctor confirms';
});

stage('pairing', () => {
    const browser = dock(['muxr', 'pair', '--browser'], { timeout: 60_000 });
    const browserOut = `${browser.stdout}\n${browser.stderr}`;
    assert(/browser hosting is off/i.test(browserOut), `unexpected browser pairing output: ${browserOut.slice(-300)}`);
    const phone = dock(['timeout', '25', 'muxr', 'pair'], { timeout: 60_000 });
    const phoneOut = `${phone.stdout}\n${phone.stderr}`;
    assert(/expir|scan|muxr:\/\//i.test(phoneOut), `phone pairing shows no material: ${phoneOut.slice(-300)}`);
    return 'browser correctly refused (hosting off); phone pairing material shown with expiry';
});

stage('socket-persistence', () => {
    cherdr(['server', 'stop'], { timeout: 60_000 });
    startHerdrServer();
    const status = cherdr(['status'], { timeout: 30_000 });
    assert(status.stdout.includes('status: running'), 'server did not come back on the same socket');
    return 'herdr socket persists across restart';
});

stage('reapply-idempotent', () => {
    const before = csh('sha256sum .muxr/selfhost.json .muxr/setup-manifest.json .config/systemd/user/muxr.service');
    const paneId = openSetupPane();
    driveSetup(paneId, APPLY_RE);
    awaitSetupDone(paneId);
    const after = csh('sha256sum .muxr/selfhost.json .muxr/setup-manifest.json .config/systemd/user/muxr.service');
    assert(before.stdout === after.stdout, `reapply changed files:\n${before.stdout}\n${after.stdout}`);
    return 'unchanged reapply is byte-identical';
});

stage('fail-malformed', () => {
    csh('cp .muxr/selfhost.json /tmp/selfhost.good.json');
    try {
        csh(`echo '{broken' > .muxr/selfhost.json`);
        const doctor = dock(['muxr', 'doctor'], { timeout: 120_000 });
        assert(/FAIL|error|invalid|corrupt/i.test(doctor.stdout), 'doctor is silent on malformed config');
        assert(!/^.*\bcomplete\b.*$/im.test(doctor.stdout.replace(/incomplete/i, '')), 'doctor says complete on malformed config');
    } finally {
        csh('cp /tmp/selfhost.good.json .muxr/selfhost.json');
    }
    return 'malformed config is reported, never complete';
});

stage('fail-port', () => {
    sysctl(['stop', 'muxr.service'], { timeout: 60_000 });
    sleep(2);
    const down = csh('curl -s --max-time 3 http://127.0.0.1:8792/health; echo PORT-TEST');
    assert(!down.stdout.includes('"ok":true'), 'relay still answers after stop');
    csh(`setsid nohup node -e "require('net').createServer().listen(8792,'127.0.0.1',()=>setInterval(()=>{},1e6))" >/dev/null 2>&1 < /dev/null & sleep 2`);
    try {
        const probe = csh(`node -e "require('net').connect(8792,'127.0.0.1').on('connect',()=>{console.log('SQUAT-OK');process.exit(0)}).on('error',()=>{console.log('SQUAT-MISS');process.exit(1)})"`);
        assert(probe.stdout.includes('SQUAT-OK'), 'port squatter did not take 8792');
        const up = csh(
            `MUXR_RELAY_LOCAL_AUTHORITY=1 MUXR_RELAY_PORT=8792 MUXR_RELAY_DATA_DIR=/home/gate/.muxr/relay timeout 15 node .npm-global/lib/node_modules/@trymuxr/cli/relay.js 2>&1; echo RELAY-EXIT=$?`,
            { timeout: 40_000 },
        );
        assert(!/listening on/i.test(up.stdout), 'occupied port reports listening');
        assert(/RELAY-EXIT=(1|[2-9]\d*|124)/.test(up.stdout) || /in use|EADDRINUSE|busy|occupied|already/i.test(up.stdout), `occupied port did not fail: ${up.stdout.slice(-300)}`);
    } finally {
        const killed = csh(`pkill -f 'listen\\(8792'; sleep 1; node -e "require('net').connect(8792,'127.0.0.1').on('connect',()=>{console.log('STILL-SQUATTED');process.exit(0)}).on('error',()=>{console.log('PORT-FREE');process.exit(1)})"`);
        assert(killed.stdout.includes('PORT-FREE'), `squatter survived: ${killed.stdout.slice(-200)}`);
    }
    const restarted = sysctl(['start', 'muxr.service'], { timeout: 60_000 });
    assert(restarted.status === 0, `service restart failed: ${restarted.stderr.slice(0, 200)}`);
    const start = Date.now();
    let health = '';
    while (!health.includes('"ok":true')) {
        if (Date.now() - start > 30_000) throw new Error(`service did not recover after the port test: ${health.slice(-200)}`);
        sleep(3);
        health = csh('curl -s --max-time 3 http://127.0.0.1:8792/health; echo').stdout;
    }
    return 'occupied port fails loudly, service recovers';
});

stage('fail-service', () => {
    const pid = sysctl(['show', 'muxr.service', '-p', 'MainPID', '--value'], { timeout: 30_000 }).stdout.trim();
    assert(/^\d+$/.test(pid) && pid !== '0', 'no supervised relay pid to kill');
    csh(`kill -9 ${pid}; sleep 2`);
    const down = csh('curl -s --max-time 3 http://127.0.0.1:8792/health; echo HEALTH-END');
    assert(!down.stdout.includes('"ok":true'), 'relay survived SIGKILL (unexpected)');
    const doctor = dock(['muxr', 'doctor'], { timeout: 120_000 });
    assert(/FAIL/.test(doctor.stdout), 'doctor shows no failure with the service dead');
    assert(!/^.*\bcomplete\b.*$/im.test(doctor.stdout.replace(/incomplete/i, '')), 'doctor says complete with the service dead');
    const start = Date.now();
    let back = '';
    while (!back.includes('"ok":true')) {
        if (Date.now() - start > 30_000) throw new Error('supervisor did not restart the relay');
        sleep(3);
        back = csh('curl -s --max-time 3 http://127.0.0.1:8792/health; echo').stdout;
    }
    return 'SIGKILL reported by doctor, supervisor restarted the relay';
});

stage('browser-loopback', () => {
    // The product gates browser hosting on secure routes only. On a loopback
    // box --web must refuse cleanly, and the LAN state must not expose it.
    const web = dock(['muxr', 'self-host', '--web', '--yes'], { timeout: 60_000 });
    const output = `${web.stdout}\n${web.stderr}`;
    assert(/https|secure|wss/i.test(output), `web hosting refusal names no secure-origin rule: ${output.slice(-300)}`);
    const webState = csh(`node -e "const s=JSON.parse(require('fs').readFileSync('.muxr/selfhost.json','utf8')); console.log(s.webEnabled === true ? 'WEB-ON' : 'WEB-OFF')"`);
    assert(webState.stdout.includes('WEB-OFF'), 'LAN state exposes the browser client');
    return 'browser hosting refused without wss; no silent exposure';
});

stage('update-check', () => {
    const check = dock(['muxr', 'update', '--check'], { timeout: 120_000 });
    assert(check.status === 0, `update --check failed: ${check.stderr.slice(0, 200)}`);
    const actions = cherdr(['plugin', 'action', 'list'], { timeout: 30_000 });
    assert(!/"plugin_id":"muxr.control"[^}]*update/i.test(actions.stdout), 'control plugin owns an update action');
    return 'update --check clean; CLI owns updates, plugin does not';
});

stage('unlink', () => {
    const unlink = cherdr(['plugin', 'unlink', 'muxr.control'], { timeout: 60_000 });
    assert(unlink.status === 0, `unlink failed: ${unlink.stderr.slice(0, 200)}`);
    const list = cherdr(['plugin', 'list'], { timeout: 30_000 });
    assert(!list.stdout.includes('muxr.control'), 'muxr.control still listed after unlink');
    const kept = csh('test -f .muxr/selfhost.json && test -f .config/systemd/user/muxr.service && echo KEPT || echo LOST');
    assert(kept.stdout.includes('KEPT'), 'unlink removed daemon or state');
    return 'shim unlinked; daemon unit and ~/.muxr intact';
});

// --- report ---------------------------------------------------------------

cleanup();
const failures = results.filter((result) => !result.ok).map((result) => result.stage);
process.stdout.write(`\ngate summary: ${results.length - failures.length}/${results.length} stages passed`);
if (failures.length > 0) process.stdout.write(`; failed: ${failures.join(', ')}`);
process.stdout.write('\n');

const report = { ref: REF, pin: state.pin, container: CONTAINER, image: IMAGE, results };
const reportJson = `${JSON.stringify(report, undefined, 2)}\n`;
const paneId = process.env.HERDR_PANE_ID?.trim();
if (paneId !== undefined && paneId !== '') {
    try {
        const dir = `/home/umer/.muxr/attachments/pane/${paneId}`;
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'plugin-onboarding-gate.json');
        writeFileSync(path, reportJson);
        process.stdout.write(`gate report: ${path}\n`);
    } catch {
        writeFileSync(join(tmpdir(), 'plugin-onboarding-gate.json'), reportJson);
    }
}
process.exit(failed ? 1 : 0);
