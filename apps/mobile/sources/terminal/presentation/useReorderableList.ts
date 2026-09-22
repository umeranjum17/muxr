import * as React from 'react';
import { hapticsLight, hapticsSelection } from '@/components/haptics';

/**
 * The reorderable list behind the control grid's two lists (keys, snippets):
 * one machine, so a change to the drag rule cannot silently diverge them.
 *
 * Two properties are deliberate and were each a bug once:
 * - the drag math lives in refs, because pan updates arrive faster than
 *   renders, so the state used for painting must never be the state used for
 *   computing; and
 * - the working copy re-seeds only on the closed→open transition, because a
 *   commit during an open edit comes back through `seed`, and re-seeding then
 *   would drop the drag halfway through.
 */

/** One row's height: the drag swaps rows at half of it. */
export const REORDER_STEP = 62;

export interface ReorderDrag {
    index: number;
    translate: number;
}

export function useReorderableList<T>(visible: boolean, seed: T[], onChange: (next: T[]) => void) {
    const [working, setWorking] = React.useState<T[]>([]);
    const [drag, setDrag] = React.useState<ReorderDrag | null>(null);
    const workingRef = React.useRef<T[]>([]);
    const dragIndex = React.useRef(0);
    const accumulated = React.useRef(0);
    const dragging = React.useRef(false);
    // Only the handle that started the drag may steer it: a second finger on
    // another handle owns a separate recognizer whose updates would otherwise
    // move the first handle's row.
    const dragOwner = React.useRef<object | null>(null);
    workingRef.current = working;

    const wasOpen = React.useRef(false);
    const openSeed = React.useRef(seed);
    openSeed.current = seed;
    React.useEffect(() => {
        if (visible && !wasOpen.current) {
            wasOpen.current = true;
            setWorking([...openSeed.current]);
            setDrag(null);
            dragging.current = false;
        }
        if (!visible) wasOpen.current = false;
    }, [visible]);

    const commit = (next: T[]) => {
        workingRef.current = next;
        setWorking(next);
        onChange(next);
    };

    // A reset is not a commit: the working copy follows the given rows while
    // the caller decides what the stored value becomes.
    const reseed = (next: T[]) => {
        workingRef.current = next;
        setWorking([...next]);
        setDrag(null);
        dragging.current = false;
    };

    const removeAt = (index: number) => {
        if (dragging.current) return;
        hapticsSelection();
        commit(workingRef.current.filter((_, i) => i !== index));
    };

    const swap = (a: number, b: number) => {
        const next = [...workingRef.current];
        [next[a], next[b]] = [next[b], next[a]];
        commit(next);
    };

    // Reordering without the drag gesture, for screen readers and anyone who
    // cannot hold and pan: the same swap the drag performs, one slot at a time.
    const moveBy = (index: number, delta: number) => {
        if (dragging.current) return;
        const target = index + delta;
        if (target < 0 || target >= workingRef.current.length) return;
        hapticsSelection();
        swap(index, target);
    };

    const onDrag = (phase: 'start' | 'update' | 'end', index: number, translationY: number, owner: object) => {
        if (phase === 'start') {
            if (dragging.current) return;
            dragging.current = true;
            dragOwner.current = owner;
            hapticsLight();
            dragIndex.current = index;
            accumulated.current = 0;
            setDrag({ index, translate: 0 });
            return;
        }
        if (!dragging.current || dragOwner.current !== owner) return;
        if (phase === 'end') {
            dragging.current = false;
            dragOwner.current = null;
            setDrag(null);
            return;
        }
        let translate = translationY - accumulated.current;
        const last = workingRef.current.length - 1;
        while (translate > REORDER_STEP / 2 && dragIndex.current < last) {
            swap(dragIndex.current, dragIndex.current + 1);
            dragIndex.current += 1;
            accumulated.current += REORDER_STEP;
            translate -= REORDER_STEP;
        }
        while (translate < -REORDER_STEP / 2 && dragIndex.current > 0) {
            swap(dragIndex.current, dragIndex.current - 1);
            dragIndex.current -= 1;
            accumulated.current -= REORDER_STEP;
            translate += REORDER_STEP;
        }
        setDrag({ index: dragIndex.current, translate });
    };

    return { working, drag, commit, reseed, removeAt, moveBy, swap, onDrag, isDragging: () => dragging.current };
}
