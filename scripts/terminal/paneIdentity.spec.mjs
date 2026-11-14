import { expect, it } from 'vitest';
import { currentPaneId } from './paneIdentity.mjs';

it('reads the trimmed pane id from the environment and treats a blank one as outside a pane', () => {
    expect(currentPaneId({ HERDR_PANE_ID: ' pp_7 \n' })).toBe('pp_7');
    expect(currentPaneId({ HERDR_PANE_ID: '' })).toBeUndefined();
    expect(currentPaneId({ HERDR_PANE_ID: '   ' })).toBeUndefined();
    expect(currentPaneId({})).toBeUndefined();
});
