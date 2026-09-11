import { describe, expect, it } from 'vitest';
import { textEdits } from './textEdits';

describe('takeover text edits', () => {
    it('sends corrections as backspaces plus a retyped tail, not as appends', () => {
        expect(textEdits('', 'abc')).toEqual({ deletions: 0, inserted: 'abc' });
        expect(textEdits('abc', 'abcd')).toEqual({ deletions: 0, inserted: 'd' });
        expect(textEdits('helo', 'hello')).toEqual({ deletions: 1, inserted: 'lo' });
        expect(textEdits('abc', 'ab')).toEqual({ deletions: 1, inserted: '' });
        expect(textEdits('abc', 'xyz')).toEqual({ deletions: 3, inserted: 'xyz' });
    });
});
