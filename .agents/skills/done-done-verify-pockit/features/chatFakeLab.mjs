// A private chat lab without Herdr: the fake-Herdr stack (real relay, host and
// E2EE pairing) with a Claude conversation seeded where the host reads Claude
// logs, so the chat view draws real `chat.read` answers: user bubbles, plain
// replies and tool chips. Run from the repo root
// (`node --input-type=module -e "$(< …/chatFakeLab.mjs)"`). CHAT_LAB_SERIAL
// (an emulator) switches to the adb transport for a native app. SIGUSR1 mints
// a browser link, SIGUSR2 a native one; SIGTERM stops the stack. See chat-view.md.
// Two of the repo's own screenshots stand in for the agent's images: one a
// Read returned, one a file the reply draws (chat-images).
// Stdin lines drive the header-fit journey (chat-header-fit.md): `status <state>
// <task>` sets Claude 1's lifecycle and task title, `changes` leaves three
// uncommitted files in its folder; `model <text>` reports the harness model and
// effort (slice-1 chip) through Herdr pane metadata, CHAT_LAB_MODEL seeds it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { startFakeStack } from './perf/lib/fakeStack.mjs';
import { setAndroidSerial } from './perf/lib/deviceTarget.mjs';

// The stack's host inherits this env: never let it find the person's own agent logs.
for (const key of Object.keys(process.env)) if (/^(CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CONFIG_DIR|CODEX_HOME|OPENCODE_\w+|XDG_(CONFIG|DATA|STATE|CACHE)_HOME)$/.test(key)) delete process.env[key];
const serial = process.env.CHAT_LAB_SERIAL;
if (serial) setAndroidSerial(serial);
const minute = (n) => new Date(Date.now() - (30 - n) * 60_000).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
const user = (id, n, content) => line({ type: 'user', uuid: id, timestamp: minute(n), message: { role: 'user', content } });
const reply = (id, n, message, content) => line({ type: 'assistant', uuid: id, timestamp: minute(n), message: { id: message, role: 'assistant', content } });
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${name}_${JSON.stringify(input).length}`, name, input });
// A tool's answer, written the way Claude Code does: a user line holding one `tool_result`, an edit's patch beside it.
const answer = (id, n, call, content, extra = {}) => line({ type: 'user', uuid: id, timestamp: minute(n), ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content, ...(extra.is_error ? { is_error: true } : {}) }] } });
const at = (folder, path) => `${folder}/${path}`;
const conversationIn = (cwd) => {
    const read1 = tool('Read', { file_path: at(cwd, 'src/checkout/shipping.ts') });
    const read2 = tool('Read', { file_path: at(cwd, 'src/checkout/shipping.test.ts') });
    const grep1 = tool('Grep', { pattern: 'FREE_FROM' });
    const edit1 = tool('Edit', { file_path: at(cwd, 'src/checkout/shipping.ts'), old_string: '  if (subtotal > FREE_FROM) return 0;', new_string: '  if (subtotal >= FREE_FROM) return 0;' });
    const test1 = tool('Bash', { command: 'yarn test shipping', description: 'Run the shipping tests' });
    const grep2 = tool('Grep', { pattern: 'subtotal === 0' });
    const edit2 = tool('Edit', { file_path: at(cwd, 'src/checkout/shipping.ts'), old_string: 'export function shipping(subtotal: number) {', new_string: 'export function shipping(subtotal: number) {\n  // An empty cart has nothing to ship.\n  if (subtotal === 0) return 0;' });
    const write1 = tool('Write', { file_path: at(cwd, 'src/checkout/shipping.empty.test.ts'), content: "import { shipping } from './shipping';\n\ntest('an empty cart ships free', () => {\n  expect(shipping(0)).toBe(0);\n});\n" });
    const plan1 = tool('TodoWrite', { todos: [{ content: 'Fix the $50 edge', status: 'completed' }, { content: 'Free shipping for an empty cart', status: 'completed' }, { content: 'Test both', status: 'completed' }] });
    const test2 = tool('Bash', { command: 'yarn test checkout --reporter=dot', description: 'Run every checkout test' });
    const look = tool('Read', { file_path: at(cwd, 'shots/voice.png') });
    const patch = (oldStart, lines) => ({ toolUseResult: { structuredPatch: [{ oldStart, oldLines: lines.filter((l) => !l.startsWith('+')).length, newStart: oldStart, newLines: lines.filter((l) => !l.startsWith('-')).length, lines }] } });
    return [
        user('u1', 1, 'Review the checkout. Keep free shipping from $50.'),
        reply('a1', 2, 'm1', [read1, read2, grep1]),
        answer('r1', 2, read1, '     1→export const FREE_FROM = 50;\n     2→export const FLAT_RATE = 5;\n     3→\n     4→export function shipping(subtotal: number) {\n     5→  if (subtotal > FREE_FROM) return 0;\n     6→  return FLAT_RATE;\n     7→}'),
        answer('r2', 2, read2, "     1→import { shipping } from './shipping';\n     2→\n     3→test('over $50 ships free', () => {\n     4→  expect(shipping(80)).toBe(0);\n     5→});"),
        answer('r3', 2, grep1, 'src/checkout/shipping.ts:1:export const FREE_FROM = 50;\nsrc/checkout/shipping.ts:5:  if (subtotal > FREE_FROM) return 0;\nsrc/cart/summary.tsx:40:  const left = FREE_FROM - subtotal;'),
        reply('a2', 3, 'm2', [{ type: 'text', text: 'Free shipping starts **above** $50, so an order of exactly `$50` still pays the flat $5.\n\n- An order of exactly $50 is charged today.\n- No test covers an empty cart.\n\nI will fix the first and add a test.' }]),
        reply('a3', 4, 'm3', [edit1, test1]),
        answer('r4', 4, edit1, 'The file has been updated.', patch(4, [' export function shipping(subtotal: number) {', '-  if (subtotal > FREE_FROM) return 0;', '+  if (subtotal >= FREE_FROM) return 0;', '   return FLAT_RATE;'])),
        answer('r5', 4, test1, 'PASS src/checkout/shipping.test.ts\n  ✓ over $50 ships free (2 ms)\n  ✓ under $50 pays the flat rate (1 ms)\n  ✓ $50 exactly ships free (1 ms)\nTests: 3 passed, 3 total'),
        reply('a4', 5, 'm4', [{ type: 'text', text: 'Changed `shipping()` to use `>= 50` and added a test for the $50 edge. All 3 tests pass.' }, look]),
        answer('r11', 5, look, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: readFileSync('apps/site/docs/marketing/demo-poster.png').toString('base64') } }]),
        reply('a8', 5, 'm7', [{ type: 'text', text: 'Here is the Files screen after the fix:\n\n![Files](shots/files.png)' }]),
        user('u2', 6, 'Good. Now check the empty cart, Umer here.'),
        reply('a5', 7, 'm5', [{ type: 'text', text: 'Checking the empty cart.' }, grep2]),
        answer('r6', 7, grep2, 'No matches found'),
        reply('a6', 8, 'm5', [edit2, write1, plan1, test2]),
        answer('r7', 8, edit2, 'The file has been updated.', patch(4, [' export function shipping(subtotal: number) {', '+  // An empty cart has nothing to ship.', '+  if (subtotal === 0) return 0;', '   if (subtotal >= FREE_FROM) return 0;'])),
        answer('r8', 8, write1, 'File created successfully.'),
        answer('r10', 8, plan1, 'Todos have been modified successfully.'),
        answer('r9', 8, test2, 'Exit code 1\n....F\nFAIL src/cart/summary.test.tsx\n  ✕ shows how much is left for free shipping\nTests: 1 failed, 4 passed, 5 total', { is_error: true }),
        reply('a7', 9, 'm6', [{ type: 'text', text: 'An empty cart now pays **$0** shipping, and a test covers it. One cart test still expects the old $50 rule; I will update it next.' }]),
    ].join('');
};

let project;
const stack = await startFakeStack({
    transport: serial ? 'adb' : 'loopback', panes: 2, agents: 2, titleChurnHz: 0,
    // The host reads Claude logs from the lab HOME, by the pane's cwd and session id.
    setupHome: (home) => {
        const cwd = join(dirname(home), 'herdr', 'project');
        project = cwd;
        const folder = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
        mkdirSync(folder, { recursive: true });
        mkdirSync(join(cwd, 'shots'), { recursive: true });
        copyFileSync('screenshots/app-store/raw/ipad-13/02-files.png', join(cwd, 'shots', 'files.png'));
        for (const id of ['gen-1', 'gen-2']) writeFileSync(join(folder, `${id}.jsonl`), conversationIn(cwd));
        return {};
    },
});
let pairing;
const stop = (code = 0) => { pairing?.release(); stack.stop(); process.exit(code); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop());
const mint = async (kind) => {
    pairing?.release();
    pairing = await stack.mintPairing({ kind });
    console.log(`${kind} link: ${pairing.code}`);
};
process.on('SIGUSR1', () => void mint('browser').catch((error) => console.error(error)));
process.on('SIGUSR2', () => void mint('native').catch((error) => console.error(error)));
// The fake Herdr's own socket; `lab.set_agent_status` is its verification-only method.
const herdr = (method, params) => new Promise((resolve, reject) => {
    const socket = createConnection(stack.cellMetricsJsonl.replace(/\.cell-metrics\.jsonl$/, ''), () => socket.write(`${JSON.stringify({ id: 'lab', method, params })}\n`));
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
        buffer += chunk;
        const reply = buffer.split('\n').slice(0, -1).map((row) => JSON.parse(row)).find((row) => row.id === 'lab');
        if (reply === undefined) return;
        socket.destroy();
        reply.error == null ? resolve(reply.result) : reject(new Error(JSON.stringify(reply.error)));
    });
});
const claude = stack.world.agents.find((agent) => agent.agent === 'claude');
// What the harness reports through Herdr pane metadata, as `muxr name --model` does.
const report = (model) => herdr('pane.report_metadata', { pane_id: claude.pane_id, tokens: { provider: 'claude', model } });
await report(process.env.CHAT_LAB_MODEL ?? 'Opus 5.5 High');
const git = (...args) => execFileSync('git', ['-c', 'user.name=Umer', '-c', 'user.email=umer@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, stdio: 'ignore' });
createInterface({ input: process.stdin }).on('line', (text) => {
    const [command, state, ...task] = text.trim().split(' ');
    const done = command === 'status' ? herdr('lab.set_agent_status', { pane_id: claude.pane_id, agent_status: state, title: task.join(' ') })
        : command === 'model' ? report([state, ...task].join(' '))
        : command === 'changes' ? Promise.resolve().then(() => {
            git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'Start');
            writeFileSync(join(project, 'notes.txt'), 'line 1\nline 2 changed\n');
            writeFileSync(join(project, 'shipping.ts'), 'export const FREE_FROM = 50;\n');
            writeFileSync(join(project, 'shipping.test.ts'), "import { FREE_FROM } from './shipping';\n");
        })
            : Promise.reject(new Error(`unknown command: ${text}`));
    done.then(() => console.log(`lab did: ${command}`), (error) => console.error(`lab failed: ${command}: ${error.message}`));
});
console.log(`lab ready: agents ${stack.world.agents.map((agent) => `${agent.agent}=${agent.pane_id}`).join(', ')}, self ${process.pid}`);
setInterval(() => {}, 1 << 30);
