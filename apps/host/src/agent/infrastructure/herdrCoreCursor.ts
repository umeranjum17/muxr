/**
 * Where Herdr Core's cursor is, for the phone's pan (jg-kile slice 7, lab only).
 *
 * Herdr ends every frame by putting the cursor back (`ESC[row;colH`, then showing it), and the
 * phone follows the cursor's row when the keyboard leaves a grid taller than its box. Core sends a
 * raw byte stream with no cursor in it and none in its API, so the bridge keeps a headless
 * terminal fed with the same bytes and reads the cursor from it. The trailer then names the
 * cursor where it already is, so it never moves the phone's own cursor, and nothing is guessed.
 * The phone also paints what the user types at once, dimmed, and moves its cursor on, expecting
 * the next frame to land on those cells as Herdr's absolute-position frames do. A frame that
 * starts with `restore()` does the same for Core's raw echo, so it overwrites the typed-ahead
 * characters instead of following them.
 */

import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

export interface CoreCursor {
    /** Put the cursor back where the screen has it now: what the phone's own typed-ahead echo moved. */
    restore: () => Buffer;
    /** Parse a screen payload; resolves to Herdr's trailer for the cursor it leaves. */
    feed: (bytes: Uint8Array) => Promise<Buffer>;
    resize: (cols: number, rows: number) => void;
    dispose: () => void;
}

export function createCoreCursor(cols: number, rows: number): CoreCursor {
    const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    const position = (): string => `\x1b[${String(terminal.buffer.active.cursorY + 1)};${String(terminal.buffer.active.cursorX + 1)}H`;
    return {
        restore: () => Buffer.from(position()),
        feed: (bytes) => new Promise((resolve) => {
            terminal.write(bytes, () => {
                resolve(Buffer.from(`${position()}\x1b[?25h`));
            });
        }),
        resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
        dispose: () => terminal.dispose(),
    };
}
