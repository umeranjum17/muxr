import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

const act = TestRenderer.act;

/**
 * Leave the session while the host attach is still in flight, then let it
 * resolve: the late channel must be closed, never installed or reported.
 */
const harness = vi.hoisted(() => ({
    resolveOpen: null as ((channel: unknown) => void) | null,
    closed: 0,
    ghosttyProps: null as Record<string, unknown> | null,
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-libghostty', () => ({
    TerminalView: React.forwardRef((props: Record<string, unknown>, _ref: unknown) => { harness.ghosttyProps = props; return null; }),
}));
vi.mock('@/encryption/base64', () => ({ decodeBase64: () => new Uint8Array(), encodeBase64: () => '' }));
vi.mock('../application/recentOutput', () => ({ beginViewportCapture: () => undefined, recordTerminalOutput: () => undefined, setTerminalColumns: () => undefined }));
vi.mock('../application/OpenTerminal', () => ({
    openTerminal: () => new Promise((resolve) => { harness.resolveOpen = resolve; }),
}));

import { TerminalView } from './TerminalView';

describe('native terminal attach ownership', () => {
    it('closes a channel that resolves after the owner unmounted and never reports it', async () => {
        const onChannel = vi.fn();
        const onStatus = vi.fn();
        let renderer!: ReturnType<typeof TestRenderer.create>;
        await act(async () => { renderer = TestRenderer.create(<TerminalView sessionId="pp_1" onChannel={onChannel} onStatus={onStatus} />); });
        await act(async () => {
            (harness.ghosttyProps!.onResize as (event: { nativeEvent: { cols: number; rows: number } }) => void)({ nativeEvent: { cols: 80, rows: 24 } });
            await Promise.resolve();
        });
        expect(harness.resolveOpen).not.toBeNull();
        expect(onStatus).toHaveBeenCalledWith('connecting');
        await act(async () => { renderer.unmount(); });
        const channel = {
            onData: vi.fn(), onState: vi.fn(), onClose: vi.fn(), resize: vi.fn(), repaint: vi.fn(),
            close: vi.fn(() => { harness.closed += 1; }),
        };
        await act(async () => { harness.resolveOpen!(channel); await Promise.resolve(); await Promise.resolve(); });
        expect(harness.closed).toBe(1);
        expect(channel.onData).not.toHaveBeenCalled();
        expect(onChannel).not.toHaveBeenCalledWith(channel);
        expect(onStatus).not.toHaveBeenCalledWith('live');
    });
});
