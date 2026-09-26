import { describe, expect, it } from 'vitest';

import { composerKeyboardProps } from './composerKeyboardProps';

describe('the composer keyboard props per pane kind', () => {
    it('hands a shell the bare keyboard: commands arrive exactly as typed', () => {
        expect(composerKeyboardProps(true)).toEqual({
            autoCapitalize: 'none',
            autoCorrect: false,
            spellCheck: false,
            smartInsertDelete: false,
        });
    });

    it('leaves an agent pane on the keyboard’s prose helpers', () => {
        expect(composerKeyboardProps(false)).toEqual({});
    });
});
