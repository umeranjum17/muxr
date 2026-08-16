import { describe, expect, it } from 'vitest';
import { subagentRoster } from './subagentRoster';
import { getPiCommand } from './toolCommand';
import { toolFilePath } from './toolDisplay';

describe('subagent activity flow', () => {
    it('renders a live roster and then its completed results with model and failure state', () => {
        expect(subagentRoster(
            {
                mode: 'parallel',
                results: [],
                progress: [
                    { agent: 'scout', status: 'running', task: 'recon', currentTool: 'bash', currentToolArgs: 'git status', toolCount: 4, turnCount: 2, tokens: 12_400, durationMs: 31_000 },
                    { agent: 'reviewer', status: 'pending', task: 'waiting' },
                ],
            },
            { agent: 'scout', model: 'cursor/composer-2.5' },
        )).toEqual([
            { agent: 'scout', status: 'running', activity: 'bash git status', cost: '2t 4⚒ 12k 31s', model: 'cursor/composer-2.5' },
            { agent: 'reviewer', status: 'pending', activity: 'waiting', cost: '', model: 'cursor/composer-2.5' },
        ]);
        expect(subagentRoster({
            mode: 'parallel',
            results: [
                { agent: 'scout', task: 'recon', exitCode: 0, usage: { turns: 11, input: 22, output: 7116 } },
                { agent: 'worker', task: 'apply', exitCode: 1, error: 'timed out', model: 'anthropic/claude-sonnet-4-6' },
            ],
        })).toEqual([
            { agent: 'scout', status: 'completed', activity: 'recon', cost: '11t 7k' },
            { agent: 'worker', status: 'failed', activity: 'timed out', cost: '', model: 'anthropic/claude-sonnet-4-6' },
        ]);
        expect(subagentRoster({ mode: 'management', results: [] })).toEqual([]);
    });

    it('only offers file paths for readable edit tools and keeps shell commands human-readable', () => {
        const rig = (read: boolean) => ({
            client: { id: 'rig', name: 'Pi', version: 'muxr' },
            rigMetadataVersion: 1,
            capabilities: { files: { read, browse: false, search: false, write: false }, rpcMethods: read ? ['abort', 'bash', 'readFile'] : ['abort', 'bash'] },
        }) as never;
        expect(toolFilePath(rig(false), { name: 'edit', input: { path: 'a.ts' } })).toBeNull();
        expect(toolFilePath(rig(true), { name: 'write', input: { path: 'a.ts' } })).toBe('a.ts');
        expect(toolFilePath(rig(true), { name: 'bash', input: { path: 'a.ts' } })).toBeNull();
        expect(getPiCommand({ name: 'agent_browser', input: { args: ['open', 'https://example.com'] } })).toBe('open https://example.com');
        expect(getPiCommand({ name: 'agent_browser', input: { qa: { url: 'https://example.com' } } })).toBeNull();
        expect(getPiCommand({ name: 'bash', input: { command: ['bash', '-lc', 'yarn typecheck'] } })).toBe('yarn typecheck');
    });
});
