import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginApprovals } from './pluginApprovals.js';

describe('plugin approval lifecycle', () => {
    it('can revoke after an approved invocation fails', async () => {
        const approvals = new PluginApprovals(await mkdtemp(join(tmpdir(), 'muxr-extension-approvals-')));
        await approvals.set('device', 'example.ui', true);
        await expect(approvals.whileApproved('device', 'example.ui', async () => 'result')).resolves.toBe('result');
        await expect(approvals.whileApproved('device', 'example.ui', async () => {
            throw new Error('action failed');
        })).rejects.toThrow('action failed');
        await approvals.set('device', 'example.ui', false);
        expect(approvals.has('device', 'example.ui')).toBe(false);
    });

    it('enables a plugin by default and keeps it on across hash changes until disabled', async () => {
        const approvals = new PluginApprovals(await mkdtemp(join(tmpdir(), 'muxr-plugin-default-on-')));
        expect(approvals.has('device', 'muxr.voice')).toBe(true);
        await approvals.set('device', 'muxr.voice', true);
        expect(approvals.has('device', 'muxr.voice')).toBe(true);
        await approvals.set('device', 'muxr.voice', false);
        expect(approvals.has('device', 'muxr.voice')).toBe(false);
        await approvals.set('device', 'muxr.voice', true);
        expect(approvals.has('device', 'muxr.voice')).toBe(true);
    });

    it('runs approved work concurrently, aborts it on revoke, and fences new work', async () => {
        const approvals = new PluginApprovals(await mkdtemp(join(tmpdir(), 'muxr-extension-approvals-')));
        await approvals.set('device', 'example.ui', true);

        let started = 0;
        let peak = 0;
        const operation = (signal: AbortSignal) => new Promise<string>((resolve) => {
            started += 1;
            peak = Math.max(peak, started);
            signal.addEventListener('abort', () => { started -= 1; resolve('aborted'); }, { once: true });
        });

        const first = approvals.whileApproved('device', 'example.ui', operation);
        const second = approvals.whileApproved('device', 'example.ui', operation);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(started).toBe(2);
        expect(peak).toBe(2);

        const revoked = approvals.set('device', 'example.ui', false);
        await expect(approvals.whileApproved('device', 'example.ui', async () => 'too late')).rejects.toThrow('being revoked');
        await expect(Promise.race([
            revoked.then(() => 'revoked'),
            new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 1_000)),
        ])).resolves.toBe('revoked');
        await expect(Promise.all([first, second])).resolves.toEqual(['aborted', 'aborted']);
        expect(started).toBe(0);
        expect(approvals.has('device', 'example.ui')).toBe(false);
    });
});
