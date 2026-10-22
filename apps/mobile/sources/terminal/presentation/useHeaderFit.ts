import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';

/** The title button's own side padding, inside the room its content gets. */
export const TITLE_BUTTON_PADDING = 3;
/** What the task keeps, at font scale 1, before anything beside it goes. */
const TITLE_FLOOR = 72;
/** The gap between the title button's items. */
const GAP = 6;
/** Room past the floor an extra must leave when it comes back, so rounding never sends it straight out again. */
const RETURN_MARGIN = 8;
/** What leaves the row, first to last, when the task would fall below its floor. */
export type HeaderExtra = 'word' | 'name' | 'account';
const ORDER: HeaderExtra[] = ['word', 'name', 'account'];

/**
 * Fits the agent header's title button into whatever the controls after it
 * leave; the chat/terminal toggle, the pane count and ⋮ never shrink. The task
 * is the one thing that shrinks. When it would fall below its floor the status
 * word goes (the dot stays), then the name, then the account chip.
 *
 * Room is read from layout, not guessed from the window: chat and terminal view
 * leave different room on one phone, and text grows with the font scale. A
 * layout pass reports its parts one by one, so the row is judged a frame later
 * on the whole pass; judged on half of one, an extra could leave that fits. An
 * extra only comes back when the room it last measured is free again, so
 * dropping one can never make the room that brings it back.
 */
export function useHeaderFit(fontScale: number, present: Record<HeaderExtra, boolean>) {
    const sizes = React.useRef({ room: 0, used: 0, title: 0, word: 0, name: 0, account: 0 });
    // Extras before this index in ORDER are out of the row.
    const [dropped, setDropped] = React.useState(0);
    const [room, setRoom] = React.useState(0);
    const facts = React.useRef({ fontScale, present, dropped });
    facts.current = { fontScale, present, dropped };
    const frame = React.useRef<number | undefined>(undefined);
    const judge = React.useCallback(() => {
        if (frame.current !== undefined) return;
        frame.current = requestAnimationFrame(() => {
            frame.current = undefined;
            const { room: width, used, title } = sizes.current;
            const { fontScale: scale, present: here, dropped: out } = facts.current;
            if (width <= 0) return;
            const floor = Math.min(TITLE_FLOOR * scale, width / 2);
            const full = used >= width - 1;
            if (full && title < floor - 1) {
                const next = ORDER.findIndex((key, index) => index >= out && here[key]);
                if (next >= 0) setDropped(next + 1);
                return;
            }
            let back = out - 1;
            while (back >= 0 && !here[ORDER[back]]) back -= 1;
            if (back < 0) return;
            const free = width - used + (full ? title - floor : 0);
            if (free >= sizes.current[ORDER[back]] + GAP + RETURN_MARGIN) setDropped(back);
        });
    }, []);
    React.useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); }, []);
    // A part that comes or goes changes the row even when nothing else lays out again.
    React.useEffect(judge, [judge, present.word, present.name, present.account]);
    const measure = React.useCallback((key: keyof typeof sizes.current) => (event: LayoutChangeEvent) => {
        sizes.current[key] = event.nativeEvent.layout.width;
        judge();
    }, [judge]);
    return {
        /** A share of the room, for a chip's cap: a percentage would resolve against the row, which sizes to its content. */
        share: (fraction: number) => (room > 0 ? room * fraction : undefined),
        shown: (key: HeaderExtra) => ORDER.indexOf(key) >= dropped,
        onRoom: React.useCallback((event: LayoutChangeEvent) => {
            sizes.current.room = event.nativeEvent.layout.width - 2 * TITLE_BUTTON_PADDING;
            setRoom(sizes.current.room);
            judge();
        }, [judge]),
        onUsed: React.useMemo(() => measure('used'), [measure]),
        onTitle: React.useMemo(() => measure('title'), [measure]),
        onWord: React.useMemo(() => measure('word'), [measure]),
        onName: React.useMemo(() => measure('name'), [measure]),
        onAccount: React.useMemo(() => measure('account'), [measure]),
    };
}
