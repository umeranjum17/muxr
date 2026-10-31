import { describe, expect, it } from 'vitest';
import { MOVE_CHUNK_BYTES } from '@trymuxr/contract';
import { moveToComputer, type MoveEndpoint } from './moveToComputer';

/** Two computers speaking the move protocol: a source that serves chunks and a destination that only accepts the next contiguous one. */
function computers(options: { dropAfterChunks?: number } = {}) {
    const bundle = Buffer.alloc(MOVE_CHUNK_BYTES * 2 + 10, 7);
    const calls: string[] = [];
    let staged = 0;
    let sent = 0;
    const source = (async (type: string, params: Record<string, number | string>) => {
        calls.push(`source ${type}`);
        if (type === 'move.export') return { transferId: 'a'.repeat(24), kind: 'claude', conversation: 'c', bytes: bundle.length, digest: 'd', cwd: '/home/u/app' };
        if (type === 'move.read') {
            if (options.dropAfterChunks !== undefined && sent++ >= options.dropAfterChunks) throw new Error('link dropped');
            const from = params.offset as number;
            const to = Math.min(from + MOVE_CHUNK_BYTES, bundle.length);
            return { offset: from, data: bundle.subarray(from, to).toString('base64'), eof: to >= bundle.length };
        }
        return null;
    }) as MoveEndpoint;
    const destination = (async (type: string, params: Record<string, number | string>) => {
        calls.push(`destination ${type}`);
        if (type === 'move.ready') return { ready: true, home: '/home/other' };
        if (type === 'move.stage') {
            if (params.offset !== staged) throw Object.assign(new Error('a piece went missing'), { code: 'move-corrupt' });
            staged += Buffer.from(params.data as string, 'base64').length;
            return { received: staged };
        }
        if (type === 'move.import') return { sessionId: 'moved', cwd: params.cwd };
        return null;
    }) as MoveEndpoint;
    return { source, destination, calls, staged: () => staged, size: bundle.length };
}
const run = (c: ReturnType<typeof computers>, buffered = false) => moveToComputer({
    source: c.source, destination: async () => c.destination, buffered, sessionId: 's', kind: 'claude', destinationName: 'Laptop',
    mapCwd: (cwd, home) => cwd.replace('/home/u', home), onStep: () => undefined,
});

describe('move to another computer: the phone carries the bundle between two computers', () => {
    it('streams every chunk in order and resumes there; a held-first destination gets the same bytes', async () => {
        const live = computers();
        expect(await run(live)).toEqual({ ok: true, sessionId: 'moved', cwd: '/home/other/app' });
        expect(live.staged()).toBe(live.size);
        const held = computers();
        expect(await run(held, true)).toMatchObject({ ok: true });
        expect(held.staged()).toBe(held.size);
        // A held bundle is fully read before the destination is opened.
        expect(held.calls.indexOf('destination move.ready')).toBeGreaterThan(held.calls.lastIndexOf('source move.read'));
    });

    it('a link that drops mid-way imports nothing, releases both sides and says the source is kept', async () => {
        const c = computers({ dropAfterChunks: 1 });
        const outcome = await run(c);
        expect(outcome).toMatchObject({ ok: false, stage: 'sending', sourceKept: true, onDestination: false });
        expect(c.calls).not.toContain('destination move.import');
        expect(c.calls.filter((call) => call.endsWith('move.release'))).toEqual(['source move.release', 'destination move.release']);
    });
});
