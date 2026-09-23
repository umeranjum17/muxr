import { describe, expect, it } from 'vitest';

import type { SessionSnapshot } from '@desklink/react-native';

import { describeDesktopOverlay } from './desktopOverlay';

function ended(message: string): SessionSnapshot {
    return {
        status: 'ended',
        geometry: null,
        presented: false,
        failure: { code: 'revoked', message },
        diagnostics: {},
    };
}

describe('the desktop overlay', () => {
    it('shows product copy when another device takes the desktop over', () => {
        const overlay = describeDesktopOverlay(ended('another device opened this computer'));

        expect(overlay.detail).toBe('This desktop is open on another device.');
        expect(overlay.detail).not.toContain('another device opened');
        expect(overlay.canRetry).toBe(true);
    });

    it('keeps an hour-limit ending retryable', () => {
        const overlay = describeDesktopOverlay(ended('the session lease expired'));

        expect(overlay.detail).toBe('This desktop closed after an hour. You can open it again.');
        expect(overlay.canRetry).toBe(true);
    });

    it('offers no retry for a reason a retry cannot fix', () => {
        expect(describeDesktopOverlay(ended('the encoder rejected a frame')).canRetry).toBe(false);
    });

    it('turns an unanswered screen-sharing prompt into the step to take, with a retry', () => {
        const overlay = describeDesktopOverlay({
            status: 'failed',
            geometry: null,
            presented: false,
            failure: { code: 'consent', message: 'consent-timeout: the portal did not answer within 30s' },
            diagnostics: {},
        });

        expect(overlay.detail).toBe('Approve screen sharing on the computer, then try again.');
        expect(overlay.detail).not.toContain('portal');
        expect(overlay.canRetry).toBe(true);
    });

    it('falls back to neutral copy for a reason it does not know', () => {
        const overlay = describeDesktopOverlay(ended('internal: something odd'));

        expect(overlay.detail).toBe('The desktop session has ended.');
        expect(overlay.detail).not.toContain('internal');
    });
});
