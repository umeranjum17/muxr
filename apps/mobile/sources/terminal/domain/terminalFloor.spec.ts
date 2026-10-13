import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_INDEX, FONT_STEPS } from './fontSteps';
import { MIN_TERMINAL_ROWS, terminalSurfaceHeight } from './terminalFloor';

describe('terminal floor on the first attach', () => {
    it('gives the grid the floor rows when the keyboard is already up and no row height is reported yet', () => {
        const fontSize = FONT_STEPS[DEFAULT_FONT_INDEX]!;
        // A renderer draws a line about 1.2 font sizes tall; the floor only ever
        // estimates it, so the grid must hold the rows at this real height.
        const drawnLine = fontSize * 1.2;
        const keyboardUpBox = 7 * drawnLine;
        const surface = terminalSurfaceHeight({ boxHeight: keyboardUpBox, cols: 45, fontIndex: DEFAULT_FONT_INDEX });
        expect(Math.floor(surface / drawnLine)).toBeGreaterThanOrEqual(MIN_TERMINAL_ROWS);
    });
});
