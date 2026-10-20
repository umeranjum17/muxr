// Pairs a native emulator to a one-agent fake stack. See notification-permission.md.
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { setAndroidSerial } from './perf/lib/deviceTarget.mjs';
import { startFakeStack } from './perf/lib/fakeStack.mjs';
import { CommandScope, useCommandScope } from './perf/lib/commands.mjs';

setAndroidSerial(process.env.SERIAL);
const scope = new CommandScope();
useCommandScope(scope);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => scope.abort());
const rpc = (stack, method, params) => new Promise((resolve, reject) => {
    const socket = createConnection(stack.cellMetricsJsonl.replace(/\.cell-metrics\.jsonl$/, ''),
        () => socket.write(`${JSON.stringify({ id: 'lab', method, params })}\n`));
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
        buffer += chunk;
        const line = buffer.split('\n').find((row, index, rows) => index < rows.length - 1 && JSON.parse(row).id === 'lab');
        if (line === undefined) return;
        socket.destroy();
        const message = JSON.parse(line);
        message.error == null ? resolve(message.result) : reject(new Error(JSON.stringify(message.error)));
    });
});
try {
    const stack = await startFakeStack({ panes: 0, agents: 0, titleChurnHz: 0 });
    const { workspace } = await rpc(stack, 'workspace.create', { label: 'api-server', cwd: '/tmp/api-server' });
    const { root_pane } = await rpc(stack, 'tab.create', { workspace_id: workspace.workspace_id, label: 'umer-api' });
    await rpc(stack, 'agent.start', { pane_id: root_pane.pane_id, kind: 'pi', name: 'umer-api' });
    await rpc(stack, 'lab.set_agent_status', { pane_id: root_pane.pane_id, agent_status: 'idle' });
    const pair = async () => {
        const pairing = await stack.mintPairing();
        scope.cleanups.push(() => pairing.release());
        await scope.run('adb', ['-s', process.env.SERIAL, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
            '-d', `'muxr://pair#${pairing.code}'`, 'com.trymuxr.app']);
        console.log('pairing link open: tap Pair on the phone');
    };
    await pair();
    console.log('Enter blocked, idle or pair; Ctrl-C stops the lab.');
    const input = createInterface({ input: process.stdin });
    scope.cleanups.push(() => input.close());
    scope.signal.addEventListener('abort', () => input.close(), { once: true });
    for await (const line of input) {
        const command = line.trim();
        const run = command === 'pair' ? pair()
            : rpc(stack, 'lab.set_agent_status', { pane_id: root_pane.pane_id, agent_status: command }).then(() => console.log(`agent ${command}`));
        await run.catch((error) => console.error(error.message));
    }
} catch (error) {
    if (!scope.signal.aborted) {
        console.error(error);
        process.exitCode = 1;
    }
} finally {
    try { await scope.close(); } finally { scope.cleanup(); }
}
