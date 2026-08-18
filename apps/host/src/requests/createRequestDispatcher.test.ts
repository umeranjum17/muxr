import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MISSING_CWD_ERROR_PREFIX } from '@muxr/contract';
import { createRequestDispatcher } from './createRequestDispatcher.js';
import type { SessionSource } from '../sessionSource.js';

function dispatcherWithSpy(): { dispatch: ReturnType<typeof createRequestDispatcher>['dispatch']; started: string[] } {
    const started: string[] = [];
    const source = {
        async start({ cwd }: { cwd: string }) {
            started.push(cwd);
            return { info: { id: 'session-1' } };
        },
    } as unknown as SessionSource;
    const { dispatch } = createRequestDispatcher({
        source,
        domain: {} as never,
        machineId: 'm1',
        hostVersion: '0.0.0',
    });
    return { dispatch, started };
}

describe('session.start cwd guard', () => {
    it('refuses a missing cwd without creating it, then creates it once approved', async () => {
        const missing = join(mkdtempSync(join(tmpdir(), 'muxr-cwd-')), 'brand-new-project');
        const { dispatch, started } = dispatcherWithSpy();

        const refused = await dispatch({ type: 'session.start', requestId: 'r1', params: { cwd: missing } } as never);
        expect(refused).toMatchObject({ ok: false });
        expect(String((refused as { error: string }).error)).toContain(MISSING_CWD_ERROR_PREFIX);
        expect(existsSync(missing)).toBe(false);
        expect(started).toEqual([]);

        const created = await dispatch({
            type: 'session.start',
            requestId: 'r2',
            params: { cwd: missing, createCwd: true },
        } as never);
        expect(created).toMatchObject({ ok: true });
        expect(existsSync(missing)).toBe(true);
        expect(started).toEqual([missing]);
    });
});

describe('plugin device authority', () => {
    it('binds approvals and calls to the authenticated sender and blocks browser mutation', async () => {
        const calls: unknown[] = [];
        const source = {
            async pluginApprove(options: unknown) { calls.push(options); },
            async pluginCall(options: unknown) { calls.push(options); return { ok: true }; },
            pluginRpcMode(options: { contributionId: string }) { return options.contributionId === 'rpc' ? 'read' as const : 'write' as const; },
        } as unknown as SessionSource;
        const { dispatch } = createRequestDispatcher({
            source,
            domain: {} as never,
            machineId: 'm1',
            hostVersion: '0.0.0',
            canMutateDevice: (deviceId) => deviceId !== 'browser-1',
        });
        const request = { type: 'plugin.approve', requestId: 'approve', params: { pluginId: 'example.ui', manifestHash: 'hash', approved: true } } as never;
        expect(await dispatch(request, 'native-1')).toMatchObject({ ok: true });
        expect(calls).toEqual([{ pluginId: 'example.ui', manifestHash: 'hash', approved: true, deviceId: 'native-1' }]);
        expect(await dispatch(request, 'browser-1')).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
        expect(calls).toHaveLength(1);
        const call = { type: 'plugin.call', requestId: 'call', params: { pluginId: 'example.ui', manifestHash: 'hash', contributionId: 'rpc', input: { value: 1 } } } as never;
        expect(await dispatch(call, 'native-1')).toMatchObject({ ok: true, data: { ok: true } });
        expect(calls[1]).toMatchObject({ deviceId: 'native-1', contributionId: 'rpc' });
        expect(await dispatch(call, 'browser-1')).toMatchObject({ ok: true, data: { ok: true } });
        const writeCall = { type: 'plugin.call', requestId: 'call-2', params: { pluginId: 'example.ui', manifestHash: 'hash', contributionId: 'write-rpc' } } as never;
        expect(await dispatch(writeCall, 'browser-1')).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
    });
});

describe('unknown request type guard', () => {
    it('answers a stable host-contract-mismatch result instead of throwing', async () => {
        const { dispatch } = dispatcherWithSpy();
        const unknown = await dispatch({ type: 'bogus.request', requestId: 'r-unknown', params: {} } as never);
        expect(unknown).toMatchObject({
            type: 'result',
            requestId: 'r-unknown',
            ok: false,
            code: 'host-contract-mismatch',
        });
        const error = (unknown as { error: string }).error;
        expect(error).toContain('host/APK contract mismatch');
        expect(error).toContain('bogus.request');
    });
});
