// Which agent CLIs report status inside Herdr Core (Herdr Core plan, slice 2, ticket jg-kile-s2).
// Starts each installed agent CLI as it is (the person's own login, normal HOME) in a private lab
// Herdr Core, gives it one tiny prompt and records the status the program itself reported over
// OSC 7501: which states, and whether it ever reported at all. A CLI that is not installed, asks a
// question before a prompt, or never reacts to the prompt reads "not measured", never a guess.
// The whole table is measured twice in two fresh cores and the two must agree. Writes
// 01-status-table.md (the dated rows), 02-repeat.txt, gate.log and steps.json. No phone, no host.
// See herdr-core-status-table.md.
//   node .agents/skills/done-done-verify-pockit/features/herdrCoreStatusTable.mjs <evidenceDir>
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const [evidence] = process.argv.slice(2);
if (!evidence) throw new Error('usage: herdrCoreStatusTable.mjs <evidenceDir>');
const repo = process.cwd();
const { startHerdrCore, HERDR_CORE_PIN } = await import(join(repo, 'perf/lib/herdrCoreLab.mjs'));
mkdirSync(evidence, { recursive: true });
const gate = join(evidence, 'gate.log');
const log = (line) => appendFileSync(gate, `${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (text) => text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?=!]*[A-Za-z]|\x1b[A-Za-z=>]|[\x00-\x08\x0b-\x1f]/g, '');
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const today = new Date().toISOString().slice(0, 10);

/** The agent kinds muxr supports. Each is started by its own command name, with no extra flags. */
const KINDS = ['claude', 'codex', 'pi', 'opencode', 'gemini', 'grok'];
const PROMPT = 'Reply with the single word ok.';
const TURN_BUDGET_MS = 75_000;
/** A screen that wants an answer first. The script never answers one, except Skip on an update notice. */
const QUESTION = /update available|trust this folder|do you trust|trust the files|not logged in|please (log|sign) in|run \/login|select login method|(log|sign) in with|enter your api key|choose (a|your) (theme|style)|press enter to continue/i;

const onPath = (name) => (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, name)).find((file) => existsSync(file));
const versionOf = (file) => {
    const out = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 15_000, cwd: repo, env: { ...process.env, CI: '1' } });
    return `${out.stdout ?? ''}${out.stderr ?? ''}`.split('\n').map((l) => l.trim()).find(Boolean) ?? 'version unreadable';
};

/** One CLI in the given core: the row's facts. Nothing here answers a dialog or edits a login. */
async function measure(core, api, events, kind, file) {
    // The CLI runs as the person's own install: normal HOME and config dirs, not the lab's private ones.
    const unset = Object.keys(core.env).filter((k) => k.startsWith('XDG_')).flatMap((k) => ['-u', k]);
    const run = await api.call('terminal.run', { argv: ['env', ...unset, `HOME=${homedir()}`, file], cwd: repo, name: `m-${kind}` });
    const address = run.address;
    const states = new Set();
    let reported = false;
    const drain = () => {
        for (const e of events.events.splice(0)) {
            const p = e.params;
            if (e.method !== 'event' || p?.terminal !== address || p.type !== 'status') continue;
            reported ||= p.data.reported === true;
            const s = p.data.status;
            if (s) states.add(s.kind ? `${s.state}(${s.kind})` : s.state);
        }
    };
    const screen = async () => plain((await api.call('terminal.read', { terminal: address })).text ?? '');
    const alive = async () => (await api.call('terminal.get', { terminal: address })).state === 'live';
    const done = async (row) => { drain(); await api.call('terminal.kill', { terminal: address }).catch(() => {}); return { kind, ...row, reported, states: [...states].sort() }; };
    try {
        await sleep(6_000);
        let before = await screen();
        if (/update available/i.test(before) && /esc skip/i.test(before)) { await api.call('terminal.keys', { terminal: address, keys: ['esc'] }); await sleep(2_000); before = await screen(); }
        drain();
        if (!(await alive())) return await done({ verdict: 'not measured: it exited at start' });
        // Some TUIs wait for the terminal's replies before they draw; a lab core has no viewer to give them.
        if (!reported && before.trim() === '') return await done({ verdict: 'not measured: it drew nothing in the lab core (no viewer attached)' });
        const asked = before.match(QUESTION);
        if (asked) return await done({ verdict: `not measured: it asks before a prompt ("${asked[0].toLowerCase()}")` });
        await api.call('terminal.send', { terminal: address, text: PROMPT });
        const end = Date.now() + TURN_BUDGET_MS;
        let settled = false;
        while (Date.now() < end && !settled && (await alive())) {
            await sleep(500);
            drain();
            const finishedTurn = [...states].some((s) => s === 'done' || s.startsWith('blocked') || s.startsWith('error'));
            settled = finishedTurn && (await api.call('terminal.get', { terminal: address })).status?.state !== 'working';
        }
        const after = await screen();
        if (reported) {
            const ended = [...states].some((s) => s === 'done');
            return await done({ verdict: `reports status${ended ? '' : '; the turn did not finish, so done is not measured'}` });
        }
        // "No status" is only claimed when the program visibly answered: a line that is just the reply.
        const answered = after.split("\n").some((l) => /^[\s│●•⏺>*-]*ok[.!]?[\s│]*$/i.test(l));
        if (!answered) return await done({ verdict: 'not measured: no answer to the prompt was seen' });
        return await done({ verdict: 'no status: it answered the prompt and reported nothing' });
    } catch (cause) {
        return await done({ verdict: `not measured: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
}

/** The whole table in one fresh lab core; installed kinds run side by side. */
async function measureAll() {
    const core = await startHerdrCore();
    const events = await core.connect();
    const api = await core.connect();
    try {
        await events.call('events.subscribe', {});
        return await Promise.all(KINDS.map(async (kind) => {
            const file = onPath(kind);
            if (!file) return { kind, version: '-', verdict: 'not measured: not installed', reported: false, states: [] };
            const version = versionOf(file);
            return { ...(await measure(core, api, events, kind, file)), version };
        }));
    } finally {
        events.close();
        api.close();
        await core.stop();
    }
}

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok }); log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };
const cell = (row) => `${row.verdict}${row.states.length ? `; states seen: ${row.states.join(', ')}` : ''}`;
const table = (rows) => [
    `| agent | version | measured | status in Herdr Core ${HERDR_CORE_PIN.version} |`,
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.kind} | ${r.version} | ${r.version === '-' ? '-' : today} | ${cell(r)} |`),
].join('\n');

try {
    const first = await measureAll();
    const second = await measureAll();
    // A state seen in one run only is timing (a short `working` can be missed), so the table keeps the
    // states both runs saw; the full second run is in 02-repeat.txt.
    const agreed = first.map((r, i) => ({ ...r, states: r.states.filter((s) => second[i].states.includes(s)) }));
    writeFileSync(join(evidence, '01-status-table.md'), [
        `Herdr Core ${HERDR_CORE_PIN.version} (SHA-256 pinned in perf/lib/herdrCoreLab.mjs), lab core, measured ${today} at ${head}.`,
        `Each row: the CLI started as installed with its own login, one prompt ("${PROMPT}"), the status events it reported.`,
        '', table(agreed), '',
    ].join('\n'));
    const key = (r) => `${r.kind}|${r.version}|${r.verdict}|${r.reported}`;
    const disagree = first.filter((r, i) => key(r) !== key(second[i]));
    writeFileSync(join(evidence, '02-repeat.txt'), [
        'second run, fresh core (the table keeps only the states both runs saw):', '', table(second), '',
        disagree.length ? `rows that differ: ${disagree.map((r) => r.kind).join(', ')}` : 'both runs agree on every row',
        '',
    ].join('\n'));
    check('one row per kind', first.length === KINDS.length && KINDS.every((k) => first.some((r) => r.kind === k)), `${first.map((r) => `${r.kind}: ${r.verdict}`).join(' | ')}`);
    check('a missing CLI reads not measured', first.filter((r) => r.version === '-').every((r) => r.verdict === 'not measured: not installed'), 'a CLI not on PATH is "not installed", never a guess');
    check('a repeat run agrees', disagree.length === 0, disagree.length ? `differs: ${disagree.map((r) => r.kind).join(', ')}` : `${first.length} rows identical in two fresh cores`);
    check('at least one CLI measured', first.some((r) => r.version !== '-' && !r.verdict.startsWith('not measured')), 'the table holds a real measurement');
} catch (cause) {
    check('journey ran', false, cause instanceof Error ? cause.stack ?? cause.message : String(cause));
}

const ok = checks.length > 0 && checks.every((c) => c.ok);
writeFileSync(join(evidence, 'steps.json'), `${JSON.stringify({
    target: { version: `this checkout's harness at ${head}, on a private lab Herdr Core ${HERDR_CORE_PIN.version}` },
    start: 'a private lab Herdr Core (2-character HC_SESSION, private XDG dirs, our own foreground child); each agent CLI runs as installed, with the normal HOME',
    steps: [
        'Check the pinned Herdr Core against the pin and the release manifest',
        'Start every installed agent CLI in the lab core and give it one prompt',
        'Record the status events each program reports; a CLI that is missing or asks a question first reads not measured',
        'Repeat in a second fresh core and compare the rows',
    ],
    result: `${ok ? 'pass' : 'fail'}: ${checks.filter((c) => c.ok).length} of ${checks.length} checks; the dated table is 01-status-table.md`,
}, null, 2)}\n`);
log(ok ? 'PASS: the status table was measured twice and agrees' : 'FAIL: see above');
console.log(`herdr-core-status-table ${ok ? 'pass' : 'fail'}: ${checks.filter((c) => c.ok).length}/${checks.length} checks; see ${gate}`);
process.exit(ok ? 0 : 1);
