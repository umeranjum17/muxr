import { describe, expect, it, vi } from 'vitest';

// The tunnel rides react-native; the stream-port resolution under test never touches it.
vi.mock('@/preview', () => ({ attachPreviewTunnel: vi.fn() }));

import { missingBrowserBinary, resolveStreamPort } from './OpenTakeover';

/**
 * Regression: when the daemon's stream is already bound (an orphaned viewer, a
 * returned deep link), `stream enable` fails with "Streaming is already enabled
 * for this session" and the takeover used to dead-end on "hasn't opened a
 * browser" even though a perfectly streamable browser was sitting there. The
 * already-enabled response must reach `stream status` and reattach to its
 * bound port.
 */

const alreadyEnabled = {
    success: false,
    stdout: JSON.stringify({ success: false, data: null, error: 'Streaming is already enabled for this session' }),
    stderr: '',
};

// The real `stream status --json` payloads (measured on 0.35.1): the stream
// server is born bound to a port, with or without a browser behind it.
const statusLive = (port: number) => JSON.stringify({
    success: true,
    data: { connected: true, enabled: true, port, screencasting: false, lifecycle: { effectiveLaunch: { browserLaunched: true } } },
});
const statusBrowserless = (port: number) => JSON.stringify({
    success: true,
    data: { connected: false, enabled: true, port, screencasting: false, lifecycle: { effectiveLaunch: { browserLaunched: false } } },
});

describe('resolveStreamPort', () => {
    it('reattaches through stream status when the daemon already streams', async () => {
        const run = vi.fn()
            .mockResolvedValueOnce(alreadyEnabled)
            .mockResolvedValueOnce({ success: true, stdout: statusLive(42249), stderr: '' });
        const result = await resolveStreamPort(run, 'agent-browser');
        expect(result).toEqual({ kind: 'ready', port: 42249, owned: false });
        expect(run).toHaveBeenNthCalledWith(1, 'agent-browser stream enable --json');
        expect(run).toHaveBeenNthCalledWith(2, 'agent-browser stream status --json');
    });

    it('a fresh enable is owned by the watcher that made it', async () => {
        const run = vi.fn().mockResolvedValue({
            success: true,
            stdout: JSON.stringify({ success: true, data: { port: 41111 } }),
            stderr: '',
        });
        const result = await resolveStreamPort(run, 'agent-browser');
        expect(result).toEqual({ kind: 'ready', port: 41111, owned: true });
    });

    it('a different enable failure stays noBrowser and never queries status', async () => {
        const run = vi.fn().mockResolvedValue({ success: false, stdout: 'No browser is open', stderr: '' });
        const result = await resolveStreamPort(run, 'agent-browser');
        expect(result).toEqual({ kind: 'noBrowser', detail: 'No browser is open' });
        expect(run).toHaveBeenCalledTimes(1);
    });

    /**
     * Regression: on agent-browser 0.35.1 every session is born with its
     * stream server bound, so enable always answers "already enabled" — with
     * or without a browser. A bound port with `connected: false` has no
     * browser behind it and would spin forever without a frame; it must keep
     * the truthful no-browser state (and its Open one action) instead.
     */
    it('a bound stream with no browser connected stays noBrowser, not a dead port', async () => {
        const run = vi.fn()
            .mockResolvedValueOnce(alreadyEnabled)
            .mockResolvedValueOnce({ success: true, stdout: statusBrowserless(33231), stderr: '' });
        const result = await resolveStreamPort(run, 'agent-browser');
        expect(result).toEqual({ kind: 'noBrowser', detail: alreadyEnabled.stdout });
        expect(run).toHaveBeenNthCalledWith(2, 'agent-browser stream status --json');
    });

    it('a missing driver is its own state so the screen can point at the install', async () => {
        const run = vi.fn().mockResolvedValue({ success: false, stdout: '', stderr: 'bash: agent-browser: command not found', exitCode: 127 });
        const result = await resolveStreamPort(run, 'agent-browser');
        expect(result).toEqual({ kind: 'noDriver', detail: 'bash: agent-browser: command not found' });
        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe('missingBrowserBinary', () => {
    it('recognises the open failure of a machine with no browser installed', () => {
        expect(missingBrowserBinary('No Chrome binary found. Run `agent-browser install` to install one.')).toBe(true);
    });

    it('leaves unrelated open failures alone', () => {
        expect(missingBrowserBinary('Failed to navigate: net::ERR_NAME_NOT_RESOLVED')).toBe(false);
    });
});
