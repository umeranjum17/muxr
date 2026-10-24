// The send-feedback stage for the installed PWA: the shared Herdr-lab Claude agent, and on
// stdin `offer` a fresh browser pairing link in <labRoot>/browser-link (mode 600) for
// `window.__MUXR_LAB_PAIR__` (a link lasts about two minutes). Other lines: `notready`
// (Herdr calls the agent unknown, so a send is held then refused), `ready`, `pane`
// (prints its recent text), `quit`. See send-feedback.md. From the repo root,
// inside a provisioned Herdr lab:
//   node .agents/skills/done-done-verify-pockit/features/sendFeedbackPwaLab.mjs <labRoot>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [root] = process.argv.slice(2);
const { startSendLab } = await import(join(process.cwd(), '.agents/skills/done-done-verify-pockit/features/sendLab.mjs'));
const stage = await startSendLab(root, { lps: '20' });
try {
    const [agent] = stage.agents;
    console.log(`lab ready: relay port ${stage.lab.port}`);
    for await (const line of createInterface({ input: process.stdin })) {
        const command = line.trim();
        if (command === 'quit') break;
        if (command === 'offer') {
            writeFileSync(join(root, 'browser-link'), await stage.offer('browser'), { mode: 0o600 });
            console.log(`browser link in ${join(root, 'browser-link')}`);
        } else if (command === 'ready' || command === 'notready') {
            stage.setReady(agent, command === 'ready');
            console.log(`agent ${command}`);
        } else if (command === 'pane') {
            console.log(stage.lab.herdr(['pane', 'read', agent.paneId, '--source', 'recent']));
        }
    }
} finally {
    await stage.stop();
    process.stdin.destroy();
}
