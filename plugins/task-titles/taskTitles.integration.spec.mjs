import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { firstUserPrompt } from './title.mjs';
import { handleStatus, rpc } from './runtime.mjs';

const root = await mkdtemp(join(tmpdir(), 'muxr-task-titles-'));
const configDir = join(root, 'muxr.task-titles');
afterAll(() => rm(root, { recursive: true, force: true }));

it('takes the first real task once and leaves manual ownership and failed generations alone', async () => {
    const pane = { pane_id: 'lab:p1', agent_session: { agent: 'codex', value: 'generation-one' }, label: null, title: null };
    const agent = { pane_id: 'lab:p1', agent_session: pane.agent_session, agent_status: 'working', name: 'Otter', title: null };
    const writes = [];
    let online = true;
    let writers = [];
    const call = async (args) => {
        if (!online) throw new Error('Herdr offline');
        if (args[0] === 'plugin' && args[1] === 'list') return JSON.stringify({ result: { plugins: writers } });
        if (args[0] === 'pane' && args[1] === 'get') return JSON.stringify({ result: { pane } });
        if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent } });
        if (args[0] === 'pane' && args[1] === 'report-metadata') {
            writes.push(args);
            pane.title = args[args.indexOf('--title') + 1];
            agent.title = pane.title;
            return '{}';
        }
        if (args[0] === 'plugin' && args[1] === 'disable') {
            writers = writers.map((writer) => writer.plugin_id === args[2] ? { ...writer, enabled: false } : writer);
            return '{}';
        }
        if (args[0] === 'plugin' && args[1] === 'enable') {
            writers = writers.map((writer) => writer.plugin_id === args[2] ? { ...writer, enabled: true } : writer);
            return '{}';
        }
        throw new Error(`unexpected Herdr call: ${args.join(' ')}`);
    };
    const event = { data: { pane_id: pane.pane_id, agent_status: 'working' } };
    const transcript = [
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md\nRules' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the auth redirect bug in login flow' }] } },
    ].map(JSON.stringify).join('\n');
    const readPrompt = async () => firstUserPrompt('codex', transcript);

    expect(await handleStatus({ event, configDir, call, readPrompt })).toMatchObject({ status: 'titled', title: 'Fix auth redirect bug' });
    expect(writes).toHaveLength(1);
    expect(agent.name).toBe('Otter');
    expect(pane.label).toBeNull();

    // A later native/muxr rename owns both display fields. Status and a fresh
    // runtime invocation (the reconnect path) must not publish again.
    pane.label = 'My manual pane';
    pane.title = 'My manual task';
    agent.title = 'My manual task';
    agent.agent_status = 'idle';
    expect(await handleStatus({ event: { data: { ...event.data, agent_status: 'idle' } }, configDir, call, readPrompt })).toMatchObject({ status: 'ignored' });
    agent.agent_status = 'working';
    expect(await handleStatus({ event, configDir, call, readPrompt })).toMatchObject({ status: 'already handled' });
    expect(writes).toHaveLength(1);
    expect(agent.title).toBe('My manual task');

    // A new generation with only a launcher envelope gets no boilerplate slug.
    pane.agent_session = { agent: 'codex', value: 'generation-two' };
    agent.agent_session = pane.agent_session;
    pane.label = null;
    pane.title = null;
    agent.title = null;
    expect(await handleStatus({ event, configDir, call, readPrompt: async () => 'FIRSTMATE_OP: v1 launch-brief: You are a crewmate' }))
        .toMatchObject({ status: 'needs title' });
    expect(writes).toHaveLength(1);

    writers = [{ plugin_id: 'herdr-plugin-renamer', name: 'Herdr Renamer', enabled: true, source: { kind: 'github' } }];
    expect(await handleStatus({ event, configDir, call, readPrompt })).toMatchObject({ status: 'conflict' });
    writers = [];
    online = false;
    expect(await handleStatus({ event, configDir, call, readPrompt })).toMatchObject({ status: 'unavailable' });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(await readFile(join(configDir, 'outcome.json'), 'utf8')).status).toBe('unavailable');

    online = true;
    pane.agent_session = { agent: 'codex', value: 'generation-three' };
    agent.agent_session = pane.agent_session;
    expect(await handleStatus({ event, configDir, call, readPrompt: async () => undefined }))
        .toMatchObject({ status: 'needs title', reason: 'No first task prompt was available.' });
    expect(writes).toHaveLength(1);

    const beforePreview = await readFile(join(configDir, 'outcome.json'), 'utf8');
    expect(await rpc('preview', { sample: 'Add dark mode to Settings' }, configDir)).toMatchObject({ confidence: 'clear task' });
    expect(await readFile(join(configDir, 'outcome.json'), 'utf8')).toBe(beforePreview);

    online = true;
    writers = [{ plugin_id: 'herdr-plugin-renamer', name: 'Herdr Renamer', enabled: true, source: { kind: 'github' } }];
    await expect(rpc('switch', { writerId: 'herdr-plugin-renamer' }, configDir, call)).rejects.toThrow('confirmation');
    expect(await rpc('switch', { writerId: 'herdr-plugin-renamer', confirm: true }, configDir, call))
        .toMatchObject({ status: 'ready', formerWriter: 'Herdr Renamer' });
    expect(writers[0].enabled).toBe(false);
    expect(await rpc('revert', { confirm: true }, configDir, call)).toMatchObject({ restoredWriter: 'Herdr Renamer' });
    expect(writers[0].enabled).toBe(true);
});
