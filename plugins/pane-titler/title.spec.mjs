import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function logged(path) {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line));
}

function session(value) {
    return { source: 'herdr:pi', agent: 'pi', kind: 'id', value };
}

describe('pane titler generation flow', () => {
    it('assigns animals, writes current-generation titles through report-metadata, and fences replacements', () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-pane-title-'));
        const bin = join(root, 'bin');
        const state = join(root, 'state');
        const log = join(root, 'herdr.log');
        const herdrState = join(root, 'herdr-state.json');
        mkdirSync(bin);
        mkdirSync(state);

        const herdr = join(bin, 'herdr');
        writeFileSync(herdr, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.TEST_HERDR_STATE;
const logPath = process.env.TEST_HERDR_LOG;
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (args[0] === 'agent' && args[1] === 'list') {
  console.log(JSON.stringify({ result: { agents: [state.agent] } }));
} else if (args[0] === 'agent' && args[1] === 'rename') {
  state.agent.name = args[3];
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ result: { agent: state.agent } }));
} else if (args[0] === 'pane' && args[1] === 'read') {
  if (state.replaceAfterRead) {
    state.agent.agent_session = { source: 'herdr:pi', agent: 'pi', kind: 'id', value: 'generation-c' };
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  console.log(state.output);
} else {
  console.log(JSON.stringify({ result: {} }));
}
`);
        chmodSync(herdr, 0o755);

        const pi = join(bin, 'pi');
        writeFileSync(pi, '#!/usr/bin/env node\nconsole.log("Current Generation Work");\n');
        chmodSync(pi, 0o755);

        const output = 'Current generation output '.repeat(10);
        const env = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HERDR_BIN_PATH: herdr,
            HERDR_PANE_ID: 'pane',
            HERDR_PLUGIN_STATE_DIR: state,
            TEST_HERDR_LOG: log,
            TEST_HERDR_STATE: herdrState,
        };
        const runTitler = (agent, extras = {}) => {
            writeFileSync(log, '');
            writeFileSync(herdrState, JSON.stringify({ output, replaceAfterRead: false, agent, ...extras }));
            const result = spawnSync(process.execPath, [join(import.meta.dirname, 'title.mjs')], { encoding: 'utf8', env });
            expect(result.status, result.stderr).toBe(0);
            return logged(log);
        };
        const expectTitleOnlyMetadata = (calls, seq) => {
            expect(calls).toContainEqual([
                'pane', 'report-metadata', 'pane',
                '--source', 'muxr.pane-titler',
                '--applies-to-source', 'herdr:pi',
                '--title', 'Current Generation Work',
                '--seq', String(seq),
            ]);
            expect(calls.some((entry) => entry[0] === 'pane' && entry[1] === 'rename')).toBe(false);
            expect(calls.some((entry) => entry[0] === 'tab' && entry[1] === 'rename')).toBe(false);
            expect(calls.some((entry) => entry.includes('--agent') || entry.includes('--display-agent'))).toBe(false);
        };

        const internal = runTitler({
            pane_id: 'pane',
            name: 'pp_deadbeef',
            agent: 'pi',
            display_agent: 'Codex',
            state_change_seq: 4,
            agent_session: session('generation-a'),
        });
        const animal = internal.find((entry) => entry[0] === 'agent' && entry[1] === 'rename');
        expect(animal?.[2]).toBe('pane');
        expect(animal?.[3]).toMatch(/^[a-z]+$/);
        expect(animal?.[3]).not.toBe('Codex');
        expect(animal?.[3]).not.toBe('pi');
        expectTitleOnlyMetadata(internal, 4);

        const preserved = runTitler({
            pane_id: 'pane',
            name: 'reviewer',
            agent: 'pi',
            display_agent: 'Codex',
            title: 'Fix Auth Flow',
            state_change_seq: 5,
            agent_session: session('generation-a'),
        });
        expect(preserved.some((entry) => entry[0] === 'agent' && entry[1] === 'rename')).toBe(false);
        expect(preserved.some((entry) => entry[0] === 'pane' && entry[1] === 'report-metadata')).toBe(false);
        expect(preserved.some((entry) => entry[0] === 'pane' && entry[1] === 'rename')).toBe(false);

        const equalName = runTitler({
            pane_id: 'pane',
            name: 'Pelican',
            agent: 'pi',
            display_agent: 'Codex',
            title: 'pelican',
            state_change_seq: 6,
            agent_session: session('generation-b'),
        });
        expect(equalName.some((entry) => entry[0] === 'agent' && entry[1] === 'rename')).toBe(false);
        expectTitleOnlyMetadata(equalName, 6);


        const replaced = runTitler({
            pane_id: 'pane',
            name: 'Pelican',
            agent: 'pi',
            display_agent: 'Codex',
            title: 'pi',
            state_change_seq: 7,
            agent_session: session('generation-b'),
        }, { replaceAfterRead: true });
        expect(replaced.some((entry) => entry[0] === 'pane' && entry[1] === 'report-metadata')).toBe(false);
        expect(replaced.some((entry) => entry[0] === 'pane' && entry[1] === 'rename')).toBe(false);
        expect(replaced.flat().join(' ')).not.toContain('generation-c');
    });
});
