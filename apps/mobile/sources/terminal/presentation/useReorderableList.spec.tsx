import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { REORDER_STEP, useReorderableList } from './useReorderableList';

/**
 * The reorder machine both editors' handles drive, in one place. It is worth a
 * test of its own rule because the rule was copied wrong once: a pan that
 * consumed a swap must subtract the step it consumed, or the row keeps
 * flinging past the finger instead of following it.
 */

vi.mock('@/components/haptics', () => ({ hapticsLight: () => undefined, hapticsSelection: () => undefined }));

function Probe({ visible, seed, onChange, list }: {
    visible: boolean;
    seed: string[];
    onChange: (next: string[]) => void;
    list: { current: ReturnType<typeof useReorderableList<string>> | null };
}) {
    list.current = useReorderableList<string>(visible, seed, onChange);
    return null;
}

function mount(seed: string[]) {
    const onChange = vi.fn();
    const list: { current: ReturnType<typeof useReorderableList<string>> | null } = { current: null };
    let renderer: any;
    TestRenderer.act(() => {
        renderer = TestRenderer.create(<Probe visible seed={seed} onChange={onChange} list={list} />);
    });
    const handle = {};
    const drag = (phase: 'start' | 'update' | 'end', index: number, translate: number) => {
        TestRenderer.act(() => { list.current!.onDrag(phase, index, translate, handle); });
    };
    const moveBy = (index: number, delta: number) => {
        TestRenderer.act(() => { list.current!.moveBy(index, delta); });
    };
    return { onChange, list, drag, moveBy, renderer: renderer! };
}

describe('the shared reorder machine', () => {
    it('swaps one slot per half row and paints the finger, in both directions', () => {
        const up = mount(['a', 'b', 'c']);
        up.drag('start', 2, 0);
        // 140px up crosses two rows: two swaps, and the paint offset is what is
        // left (140 - 2x62), not the raw translation again.
        up.drag('update', 2, -140);
        expect(up.onChange).toHaveBeenLastCalledWith(['c', 'a', 'b']);
        expect(up.list.current!.drag).toEqual({ index: 0, translate: -140 + REORDER_STEP * 2 });
        // A second update carrying the same translation must not consume the
        // step again: that is the fling the copied sign bug caused.
        const calls = up.onChange.mock.calls.length;
        up.drag('update', 2, -140);
        expect(up.onChange.mock.calls.length).toBe(calls);
        expect(up.list.current!.drag).toEqual({ index: 0, translate: -140 + REORDER_STEP * 2 });
        up.drag('end', 2, -140);
        expect(up.list.current!.drag).toBeNull();

        const down = mount(['a', 'b', 'c']);
        down.drag('start', 0, 0);
        down.drag('update', 0, 90);
        expect(down.onChange).toHaveBeenLastCalledWith(['b', 'a', 'c']);
        expect(down.list.current!.drag).toEqual({ index: 1, translate: 90 - REORDER_STEP });
    });

    it('offers the same swap to screen readers, and re-seeds only when it opens', () => {
        const list = mount(['a', 'b', 'c']);
        list.moveBy(0, 1);
        expect(list.onChange).toHaveBeenLastCalledWith(['b', 'a', 'c']);
        list.moveBy(1, -1);
        expect(list.onChange).toHaveBeenLastCalledWith(['a', 'b', 'c']);
        TestRenderer.act(() => { list.list.current!.removeAt(1); });
        expect(list.onChange).toHaveBeenLastCalledWith(['a', 'c']);

        // A commit during an open edit comes back through `seed`; re-seeding
        // while open would drop a drag in progress.
        TestRenderer.act(() => {
            list.renderer.update(<Probe visible seed={['x', 'y']} onChange={list.onChange} list={list.list} />);
        });
        expect(list.list.current!.working).toEqual(['a', 'c']);
        // Closing and opening again starts from the seed it was handed.
        TestRenderer.act(() => {
            list.renderer.update(<Probe visible={false} seed={['x', 'y']} onChange={list.onChange} list={list.list} />);
        });
        TestRenderer.act(() => {
            list.renderer.update(<Probe visible seed={['x', 'y']} onChange={list.onChange} list={list.list} />);
        });
        expect(list.list.current!.working).toEqual(['x', 'y']);
    });
});
