// Seeds Spaces on a fake-Herdr stack and pairs the emulator. See spaces-pinned.md.
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { setAndroidSerial } from './perf/lib/deviceTarget.mjs';
import { startFakeStack } from './perf/lib/fakeStack.mjs';

setAndroidSerial(process.env.SERIAL);
const stack = await startFakeStack({ panes: 1, agents: 1, titleChurnHz: 0 });
let pairing;
// A standalone run has no command scope, so nothing else stops the stack.
const stop = (code = 0) => { pairing?.release(); stack.stop(); process.exit(code); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop());
const herdrSocket = stack.cellMetricsJsonl.replace(/\.cell-metrics\.jsonl$/, '');
let next = 0;
const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `lab_${next++}`;
    const socket = createConnection(herdrSocket, () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    let buffer = '';
    socket.on('error', reject);
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
try {
    for (const [label, agents] of [['api-server', ['umer-api', 'umer-auth']], ['infra', ['umer-certs']], ['mobile-app', ['umer-ui']]]) {
        const { workspace } = await rpc('workspace.create', { label, cwd: `/tmp/${label}` });
        for (const name of agents) {
            const { root_pane } = await rpc('tab.create', { workspace_id: workspace.workspace_id, label: name });
            await rpc('agent.start', { pane_id: root_pane.pane_id, kind: 'pi', name });
        }
    }
    pairing = await stack.mintPairing();
} catch (error) {
    console.error(error);
    stop(1);
}
// Maestro does not see every emulator serial; the app's own pair link does.
const opened = spawnSync('adb', ['-s', process.env.SERIAL, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
    '-d', `'muxr://pair#${pairing.code}'`, 'com.trymuxr.app'], { stdio: 'inherit' });
console.log(opened.status === 0 ? `lab ready on relay port ${stack.relayPort}: tap Pair on the phone` : `pair link failed: ${opened.status}`);
