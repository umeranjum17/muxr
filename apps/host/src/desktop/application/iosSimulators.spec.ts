import { describe, expect, it } from 'vitest';

import { IosMirrors } from './iosSimulators.js';

/**
 * The iOS preview toolbar's device keys, pane to the bytes the simulator
 * receives. Home and Lock are the two the phone offers; the host must turn
 * each chord into the idb HID button the simulator acts on (HOME=1, LOCK=2),
 * and must not turn anything else into a device action.
 */

const mirrors = new IosMirrors();

describe('the iOS simulator device keys', () => {
    it('maps Ctrl+H to the Home button, down before up', () => {
        expect(mirrors.deviceKey({ kind: 'key', character: 'h', down: true, modifiers: ['Control'] })).toEqual(
            Buffer.from('00000000080a060a0412020801', 'hex'),
        );
        expect(mirrors.deviceKey({ kind: 'key', character: 'h', down: false, modifiers: ['Control'] })).toEqual(
            Buffer.from('000000000a0a080a04120208011001', 'hex'),
        );
        // A bare h is typing, never Home.
        expect(mirrors.deviceKey({ kind: 'key', character: 'h', down: true })).toBeUndefined();
    });

    it('maps Ctrl+L to the Lock button, down before up', () => {
        expect(mirrors.deviceKey({ kind: 'key', character: 'l', down: true, modifiers: ['Control'] })).toEqual(
            Buffer.from('00000000080a060a0412020802', 'hex'),
        );
        expect(mirrors.deviceKey({ kind: 'key', character: 'l', down: false, modifiers: ['Control'] })).toEqual(
            Buffer.from('000000000a0a080a04120208021001', 'hex'),
        );
        // A bare l is typing, never Lock.
        expect(mirrors.deviceKey({ kind: 'key', character: 'l', down: true })).toBeUndefined();
    });

    it('ignores a key that is not a device key', () => {
        expect(mirrors.deviceKey({ kind: 'key', character: 'k', down: true, modifiers: ['Control'] })).toBeUndefined();
    });
});
