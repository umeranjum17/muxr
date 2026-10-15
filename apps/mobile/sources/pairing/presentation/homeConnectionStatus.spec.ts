import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({ t: (key: string) => key }));

import type { Theme } from '@/theme';
import {
    connectionStatusPresentation,
    connectionStatusSubtitle,
    summarizeConnection,
} from './homeConnectionStatus';

const theme = {
    colors: {
        status: {
            connected: 'green',
            connecting: 'yellow',
            disconnected: 'grey',
            error: 'red',
            default: 'grey',
        },
    },
} as unknown as Theme;

/**
 * The iPad QA split: Home said offline while Connection said connected for
 * the same machine at the same moment. Both surfaces derive from
 * summarizeConnection, so these cases pin the agreement: the socket owns
 * online/offline, the runtime is a separate sentence, never an offline label.
 */
describe('header/connection agreement', () => {
    it('runtime down with the link up: header is not offline, connection names the runtime', () => {
        const socket = { status: 'connected', error: null };
        const summary = summarizeConnection(socket, false);
        expect(summary).toEqual({ linkDown: false, runtimeDown: true });

        const header = connectionStatusPresentation(socket, theme, summary.linkDown);
        expect(header.text).toBe('status.connected');

        const subtitle = connectionStatusSubtitle({ status: 'connected', hostRefresh: 'ready', herdrRuntime: false });
        expect(subtitle).toContain('agent runtime is not answering');
    });

    it('fully online: both surfaces agree the computer answered', () => {
        const socket = { status: 'connected', error: null };
        const summary = summarizeConnection(socket, true);
        expect(summary).toEqual({ linkDown: false, runtimeDown: false });

        expect(connectionStatusPresentation(socket, theme, summary.linkDown).text).toBe('status.connected');
        expect(connectionStatusSubtitle({ status: 'connected', hostRefresh: 'ready', herdrRuntime: true }))
            .toBe('Relay connected; the computer answered the last check.');
    });

    it('unknown runtime stays quiet: no false runtime alarm on either surface', () => {
        const socket = { status: 'connected', error: null };
        expect(summarizeConnection(socket, undefined)).toEqual({ linkDown: false, runtimeDown: false });
        expect(connectionStatusSubtitle({ status: 'connected', hostRefresh: 'ready', herdrRuntime: undefined }))
            .toBe('Relay connected; the computer answered the last check.');
    });

    it('link down: header is offline and connection shows the link failure', () => {
        for (const status of ['disconnected', 'error']) {
            const socket = { status, error: null };
            const summary = summarizeConnection(socket, false);
            expect(summary.linkDown).toBe(true);
            expect(summary.runtimeDown).toBe(false);

            expect(connectionStatusPresentation(socket, theme, summary.linkDown).text).toBe('status.offline');
            expect(connectionStatusSubtitle({ status, hostRefresh: 'ready', herdrRuntime: false }))
                .toBe('The app reconnects on its own when the machine is back');
        }
    });

    it('a dead grant still reads as a pairing issue in the header, not offline', () => {
        const socket = { status: 'error', error: 'Access removed: revoked' };
        expect(connectionStatusPresentation(socket, theme, true).text).toBe('needs pairing');
    });
});
