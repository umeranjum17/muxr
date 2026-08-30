import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function logged(path) {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line));
}

function session(agent, value) {
    return { source: `herdr:${agent}`, agent, kind: 'id', value };
}

describe('pane titler generation flow', () => {
    it('assigns animals, writes current-generation titles through report-metadata, and fences replacements', () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-pane-title-'));
        const bin = join(root, 'bin');
        const state = join(root, 'state');
        const log = join(root, 'herdr.log');
        const piLog = join(root, 'pi.log');
        const providerLog = join(root, 'provider.log');
        const configLog = join(root, 'config.log');
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
        writeFileSync(pi, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.TEST_PI_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log("Current Generation Work");\n');
        chmodSync(pi, 0o755);

        const acpAgent = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
fs.appendFileSync(process.env.TEST_PROVIDER_LOG, JSON.stringify({
  command: path.basename(process.argv[1]),
  args: process.argv.slice(2),
  env: {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE,
    CODEX_PATH: process.env.CODEX_PATH,
    CODEX_CONFIG: process.env.CODEX_CONFIG,
  },
}) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'title-session' } });
  } else if (message.method === 'session/set_config_option') {
    fs.appendFileSync(process.env.TEST_CONFIG_LOG, JSON.stringify(message.params) + '\\n');
    send({ jsonrpc: '2.0', id: message.id, result: { configOptions: [] } });
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'title-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Current Generation Work' } },
    } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
});
`;
        for (const command of ['cursor-agent', 'opencode']) {
            const file = join(bin, command);
            writeFileSync(file, acpAgent);
            chmodSync(file, 0o755);
        }
        const providerCli = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_PROVIDER_LOG, JSON.stringify({
  command: path.basename(process.argv[1]),
  args,
  env: {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE,
    CODEX_PATH: process.env.CODEX_PATH,
  },
}) + '\\n');
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const output = args.indexOf('--output-last-message');
  if (output >= 0) fs.writeFileSync(args[output + 1], 'Current Generation Work\\n');
  else console.log('Current Generation Work');
});
`;
        for (const command of ['claude', 'codex']) {
            const file = join(bin, command);
            writeFileSync(file, providerCli);
            chmodSync(file, 0o755);
        }

        const output = 'Current generation output '.repeat(10);
        const env = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            HERDR_BIN_PATH: herdr,
            HERDR_PANE_ID: 'pane',
            HERDR_PLUGIN_STATE_DIR: state,
            TEST_HERDR_LOG: log,
            TEST_HERDR_STATE: herdrState,
            TEST_PI_LOG: piLog,
            TEST_PROVIDER_LOG: providerLog,
            TEST_CONFIG_LOG: configLog,
        };
        const runTitler = (agent, extras = {}) => {
            writeFileSync(log, '');
            writeFileSync(piLog, '');
            writeFileSync(providerLog, '');
            writeFileSync(configLog, '');
            writeFileSync(herdrState, JSON.stringify({ output, replaceAfterRead: false, agent, ...extras }));
            const result = spawnSync(process.execPath, [join(import.meta.dirname, 'title.mjs')], { encoding: 'utf8', env });
            expect(result.status, result.stderr).toBe(0);
            return { herdr: logged(log), pi: logged(piLog), provider: logged(providerLog), config: logged(configLog) };
        };
        const expectTitleOnlyMetadata = (calls, seq, agent = 'pi') => {
            expect(calls).toContainEqual([
                'pane', 'report-metadata', 'pane',
                '--source', 'muxr.pane-titler.v3',
                '--agent', agent,
                '--title', 'Current Generation Work',
                '--seq', String(seq),
            ]);
            expect(calls.some((entry) => entry[0] === 'pane' && entry[1] === 'rename')).toBe(false);
            expect(calls.some((entry) => entry[0] === 'tab' && entry[1] === 'rename')).toBe(false);
            expect(calls.some((entry) => entry.includes('--display-agent'))).toBe(false);
        };

        const internal = runTitler({
            pane_id: 'pane',
            name: 'pp_deadbeef',
            agent: 'pi',
            display_agent: 'Codex',
            state_change_seq: 4,
            agent_session: session('pi', 'generation-a'),
        });
        const animal = internal.herdr.find((entry) => entry[0] === 'agent' && entry[1] === 'rename');
        expect(animal?.[2]).toBe('pane');
        expect(animal?.[3]).toMatch(/^[a-z]+$/);
        expect(animal?.[3]).not.toBe('Codex');
        expect(animal?.[3]).not.toBe('pi');
        expectTitleOnlyMetadata(internal.herdr, 4);
        expect(internal.pi[0]).toEqual(expect.arrayContaining(['--model', 'opencode-go/deepseek-v4-flash']));

        const preserved = runTitler({
            pane_id: 'pane',
            name: 'operator',
            agent: 'pi',
            display_agent: 'Codex',
            title: 'Fix Auth Flow',
            state_change_seq: 5,
            agent_session: session('pi', 'generation-a'),
        });
        expect(preserved.herdr.some((entry) => entry[0] === 'agent' && entry[1] === 'rename')).toBe(false);
        expect(preserved.herdr.some((entry) => entry[0] === 'pane' && entry[1] === 'report-metadata')).toBe(false);
        expect(preserved.herdr.some((entry) => entry[0] === 'pane' && entry[1] === 'rename')).toBe(false);
        expect(preserved.pi).toEqual([]);

        const equalName = runTitler({
            pane_id: 'pane',
            name: 'Pelican',
            agent: 'codex',
            display_agent: 'Codex',
            title: 'pelican',
            state_change_seq: 6,
            agent_session: session('codex', 'generation-b'),
        });
        expect(equalName.herdr.some((entry) => entry[0] === 'agent' && entry[1] === 'rename')).toBe(false);
        expectTitleOnlyMetadata(equalName.herdr, 6, 'codex');
        expect(equalName.pi).toEqual([]);
        expect(equalName.provider).toEqual([expect.objectContaining({
            command: 'codex',
            args: expect.arrayContaining([
                'exec', '--model', 'gpt-5.4-mini', '--config', 'model_reasoning_effort="low"',
                '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-',
            ]),
            env: expect.objectContaining({ CODEX_PATH: 'codex' }),
        })]);

        const providers = [
            ['claude', 'claude', ['--print', '--model', 'haiku', '--safe-mode', '--tools', '', '--permission-mode', 'dontAsk', '--no-session-persistence'], { ANTHROPIC_MODEL: 'haiku', CLAUDE_CODE_EXECUTABLE: 'claude' }],
            ['cursor', 'cursor-agent', ['--model', 'auto', 'acp'], {}],
            ['opencode', 'opencode', ['acp', '--pure', '--cwd'], {}],
        ];
        for (const [kind, command, args, expectedEnv] of providers) {
            const result = runTitler({
                pane_id: 'pane',
                name: 'Pelican',
                agent: kind,
                title: kind,
                state_change_seq: 6,
                agent_session: session(kind, `generation-${kind}`),
            });
            expectTitleOnlyMetadata(result.herdr, 6, kind);
            expect(result.pi).toEqual([]);
            expect(result.provider).toEqual([expect.objectContaining({
                command,
                args: expect.arrayContaining(args),
                env: expect.objectContaining(expectedEnv),
            })]);
            if (kind === 'opencode') {
                expect(result.provider[0].args).not.toContain('--model');
                expect(result.config).toEqual([{
                    sessionId: 'title-session',
                    configId: 'model',
                    value: 'opencode-go/deepseek-v4-flash',
                }]);
            } else {
                expect(result.config).toEqual([]);
            }
        }


        const replaced = runTitler({
            pane_id: 'pane',
            name: 'Pelican',
            agent: 'pi',
            display_agent: 'Codex',
            title: 'pi',
            state_change_seq: 7,
            agent_session: session('pi', 'generation-b'),
        }, { replaceAfterRead: true });
        expect(replaced.herdr.some((entry) => entry[0] === 'pane' && entry[1] === 'report-metadata')).toBe(false);
        expect(replaced.herdr.some((entry) => entry[0] === 'pane' && entry[1] === 'rename')).toBe(false);
        expect(replaced.herdr.flat().join(' ')).not.toContain('generation-c');

        const noSession = runTitler({
            pane_id: 'pane',
            name: 'fox',
            agent: 'opencode',
            title: 'OpenCode',
            state_change_seq: 8,
        });
        expectTitleOnlyMetadata(noSession.herdr, 8, 'opencode');
        expect(noSession.herdr.some((entry) => entry[0] === 'pane' && entry[1] === 'rename')).toBe(false);
    });
});
