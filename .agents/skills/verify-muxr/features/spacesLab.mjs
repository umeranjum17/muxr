// Seeds Spaces and pairs a native emulator. See spaces-pinned.md.
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { setAndroidSerial } from './perf/lib/deviceTarget.mjs';
import { startFakeStack, startLiveStack } from './perf/lib/fakeStack.mjs';
import { CommandScope, useCommandScope } from './perf/lib/commands.mjs';

setAndroidSerial(process.env.SERIAL);
// Optional array of task-owned live-stack configs, provisioned by the lab helper.
const configs = process.env.SPACES_LAB_HOSTS ? JSON.parse(readFileSync(process.env.SPACES_LAB_HOSTS, 'utf8')) : null;
const stacks = [];
const scope = new CommandScope();
useCommandScope(scope);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => scope.abort());
let next = 0;
const rpc = (stack, method, params) => new Promise((resolve, reject) => {
    const id = `lab_${next++}`;
    const socket = createConnection(stack.cellMetricsJsonl.replace(/\.cell-metrics\.jsonl$/, ''),
        () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    let buffer = '';
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('Lab RPC socket closed')));
    scope.cleanups.push(() => socket.destroy());
    socket.on('data', (chunk) => {
        buffer += chunk;
        for (const line of buffer.split('\n').slice(0, -1)) {
            const message = JSON.parse(line);
            if (message.id !== id) continue;
            socket.destroy();
            message.error == null ? resolve(message.result) : reject(new Error(JSON.stringify(message.error)));
        }
    });
});
const pair = async (index) => {
    const stack = stacks[index];
    if (!stack) throw new Error('Choose a lab computer number');
    const pairing = await stack.mintPairing();
    scope.cleanups.push(() => pairing.release());
    await scope.run('adb', ['-s', process.env.SERIAL, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
        '-d', `'muxr://pair#${pairing.code}'`, 'com.trymuxr.app']);
    console.log(`lab computer ${index + 1} ready on relay port ${stack.relayPort}: tap Pair on the phone`);
};
try {
    if (configs) {
        for (const config of configs) stacks.push(await startLiveStack(config));
    } else {
        const stack = await startFakeStack({ panes: 1, agents: 1, titleChurnHz: 0 });
        stacks.push(stack);
        for (const [label, agents] of [['api-server', ['umer-api', 'umer-auth']], ['infra', ['umer-certs']], ['mobile-app', ['umer-ui']]]) {
            const { workspace } = await rpc(stack, 'workspace.create', { label, cwd: `/tmp/${label}` });
            for (const name of agents) {
                const { root_pane } = await rpc(stack, 'tab.create', { workspace_id: workspace.workspace_id, label: name });
                await rpc(stack, 'agent.start', { pane_id: root_pane.pane_id, kind: 'pi', name });
            }
        }
    }
    await pair(0);
    console.log('Enter a computer number to open its pairing link; Ctrl-C stops only these hosts.');
    scope.signal.throwIfAborted();
    const input = createInterface({ input: process.stdin });
    scope.cleanups.push(() => input.close());
    scope.signal.addEventListener('abort', () => input.close(), { once: true });
    for await (const line of input) {
        await pair(Number(line.trim()) - 1).catch((error) => console.error(error.message));
    }
} catch (error) {
    if (!scope.signal.aborted) {
        console.error(error);
        process.exitCode = 1;
    }
} finally {
    try { await scope.close(); } finally { scope.cleanup(); }
}
