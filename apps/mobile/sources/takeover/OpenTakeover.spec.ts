import { describe, expect, it, vi } from 'vitest';

// The tunnel rides react-native; the stream-port resolution under test never touches it.
vi.mock('@/preview', () => ({ attachPreviewTunnel: vi.fn() }));

import { resolveStreamPort } from './OpenTakeover';

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

describe('resolveStreamPort', () => {
    it('reattaches through stream status when the daemon already streams', async () => {
        const run = vi.fn()
            .mockResolvedValueOnce(alreadyEnabled)
            .mockResolvedValueOnce({
                success: true,
                stdout: JSON.stringify({ success: true, data: { enabled: true, port: 42249, connected: false, screencasting: false } }),
                stderr: '',
            });
        const result = await resolveStreamPort(run, 'agent-browser');
        expect(result).toEqual({ kind: 'ready', port: 42249 });
        expect(run).toHaveBeenNthCalledWith(1, 'agent-browser stream enable --json');
        expect(run).toHaveBeenNthCalledWith(2, 'agent-browser stream status --json');
    });

    it('a different enable failure stays noBrowser and never queries status', async () => {
        const run = vi.fn().mockResolvedValue({ success: false, stdout: 'No browser is open', stderr: '' });
        const result = await resolveStreamPort(run, 'agent-browser');
        expect(result).toEqual({ kind: 'noBrowser', detail: 'No browser is open' });
        expect(run).toHaveBeenCalledTimes(1);
    });
});
