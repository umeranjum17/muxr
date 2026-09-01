import { describe, expect, it } from 'vitest';
import { shellQuote } from './shellQuote';

describe('shellQuote', () => {
    it('keeps hostile filenames inside one shell argument', () => {
        expect(shellQuote(`it's \"$(touch /tmp/should-not-run)\"`)).toBe(`'it'\\''s "$(touch /tmp/should-not-run)"'`);
    });
});
