import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('pane titler generation flow', () => {
    it('recomputes the current Herdr title instead of restoring a prior pane generation', () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-pane-title-'));
        const bin = join(root, 'bin');
        const state = join(root, 'state');
        const log = join(root, 'herdr.log');
        mkdirSync(bin);
        mkdirSync(state);
        writeFileSync(join(state, 'named.json'), JSON.stringify({ pane: 'Old Generation Task' }));

        const herdr = join(bin, 'herdr');
        writeFileSync(herdr, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_HERDR_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'agent' && args[1] === 'list') console.log(JSON.stringify({ result: { agents: [{ pane_id: 'pane', name: 'Pelican', agent: 'pi', agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'id', value: 'generation-b' } }] } }));
else if (args[0] === 'pane' && args[1] === 'get') console.log(JSON.stringify({ result: { pane: { pane_id: 'pane', tab_id: 'tab', label: 'pi', agent: 'pi', agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'id', value: 'generation-b' } } } }));
else if (args[0] === 'tab' && args[1] === 'get') console.log(JSON.stringify({ result: { tab: { tab_id: 'tab', label: 'pi' } } }));
else if (args[0] === 'pane' && args[1] === 'read') console.log('Current generation output '.repeat(10));
else console.log(JSON.stringify({ result: {} }));
`);
        chmodSync(herdr, 0o755);

        const pi = join(bin, 'pi');
        writeFileSync(pi, '#!/usr/bin/env node\nconsole.log("Current Generation Work");\n');
        chmodSync(pi, 0o755);
        const result = spawnSync(process.execPath, [join(import.meta.dirname, 'title.mjs')], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ''}`,
                HERDR_BIN_PATH: herdr,
                HERDR_PANE_ID: 'pane',
                HERDR_PLUGIN_STATE_DIR: state,
                TEST_HERDR_LOG: log,
            },
        });
        expect(result.status, result.stderr).toBe(0);
        const calls = readFileSync(log, 'utf8');
        expect(calls).toContain('["pane","rename","pane","Current Generation Work"]');
        expect(calls).not.toContain('Old Generation Task');
    });
});
