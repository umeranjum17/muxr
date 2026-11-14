import { expect, it } from 'vitest';
import { paneIdFromEnvironment } from './paneIdentity.js';

it('reads the trimmed pane id and treats an absent or blank one as no pane', () => {
    expect(paneIdFromEnvironment({ HERDR_PANE_ID: ' pp_7 \n' })).toBe('pp_7');
    expect(paneIdFromEnvironment({ HERDR_PANE_ID: '' })).toBeUndefined();
    expect(paneIdFromEnvironment({ HERDR_PANE_ID: '   ' })).toBeUndefined();
    expect(paneIdFromEnvironment({ PATH: '/usr/bin' })).toBeUndefined();
});
