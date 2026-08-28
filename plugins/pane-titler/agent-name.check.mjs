import assert from 'node:assert/strict';
import { ensureAgentName, readAgentName, renameAgent } from './agent-name.mjs';

const agents = [
    { pane_id: 'p-real', name: 'reviewer' },
    { pane_id: 'p-weird', name: 'Мария' },
    { pane_id: 'p-internal', name: 'pp_deadbeef' },
];
const renames = [];
const run = (args) => {
    if (args[0] === 'agent' && args[1] === 'list') return JSON.stringify({ result: { agents } });
    if (args[0] === 'agent' && args[1] === 'rename') {
        const agent = agents.find((candidate) => candidate.pane_id === args[2]);
        assert(agent, 'rename targets a real Herdr agent');
        agent.name = args[3];
        renames.push([args[2], args[3]]);
        return JSON.stringify({ result: { agent } });
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
};

assert.equal(readAgentName(run, 'p-internal'), undefined);
assert.deepEqual(renames, [], 'read mode hides internal names without mutating Herdr');
assert.equal(readAgentName(run, 'p-weird'), 'Мария');
assert.equal(renameAgent(run, 'p-weird', 'Мария'), 'Мария');
assert.deepEqual(renames, [], 'submitting an unchanged nonconforming real name is a no-op');
assert.equal(ensureAgentName(run, 'p-real'), 'reviewer');
assert.deepEqual(renames, [], 'a real existing Herdr Agent Name is preserved');
const fallback = ensureAgentName(run, 'p-internal');
assert.match(fallback, /^\p{L}+$/u, 'an available animal has no numeric suffix');
assert.equal(renameAgent(run, 'p-internal', 'Nova Team'), 'nova-team');
agents[2].pane_id = 'p-moved';
assert.equal(ensureAgentName(run, 'p-moved'), 'nova-team');
assert.equal(renames.length, 2, 'the real Herdr name survives a pane move without pane-local state');
console.log('pane-titler Agent Name flow: ok');
