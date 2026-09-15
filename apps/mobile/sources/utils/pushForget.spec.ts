import { describe, expect, it } from 'vitest';
import { resolveForgetPushAction } from './pushForget';

describe('resolveForgetPushAction', () => {
    it('leaves the endpoint alone when a background machine is forgotten', () => {
        expect(resolveForgetPushAction(false, 2)).toBe('none');
        expect(resolveForgetPushAction(false, 0)).toBe('none');
    });

    it('deletes the server endpoint when the last machine is forgotten', () => {
        expect(resolveForgetPushAction(true, 0)).toBe('delete-endpoint');
    });

    it('rebinds instead of deleting when one of several machines is forgotten', () => {
        // The exact traced regression: pair A (current) + B, forget A, and
        // B's notifications must keep working — deleting the endpoint here
        // kills the survivor's push with no error shown.
        expect(resolveForgetPushAction(true, 1)).toBe('rebind-endpoint');
        expect(resolveForgetPushAction(true, 3)).toBe('rebind-endpoint');
    });
});
