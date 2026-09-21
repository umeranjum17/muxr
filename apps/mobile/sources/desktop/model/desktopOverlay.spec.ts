import { describe, expect, it } from 'vitest';

import type { SessionSnapshot } from '@desklink/react-native';

import { describeDesktopOverlay } from './desktopOverlay';

function snapshot(patch: Partial<SessionSnapshot>): SessionSnapshot {
    return {
        status: 'idle',
        geometry: null,
        presented: false,
        failure: null,
        diagnostics: {},
        ...patch,
    };
}

describe('the desktop overlay', () => {
    it('shows why the engine ended the session instead of the generic ended copy', () => {
        const reason = 'This desktop closed because it reached its time limit.';
        const overlay = describeDesktopOverlay(
            snapshot({ status: 'ended', failure: { code: 'revoked', message: reason } }),
        );

        expect(overlay.detail).toBe(reason);
        expect(overlay.detail).not.toBe('The desktop session has ended.');
        // An ended session is over; a retry would only repeat it.
        expect(overlay.canRetry).toBe(false);
    });
});
