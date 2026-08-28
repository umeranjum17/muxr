/**
 * Herdr split-tree projection. Pane ids stay on the live tree; snapshots carry
 * Provider Kind and cwd so a layout can be reapplied after panes move.
 */

import type { LayoutSnapshot } from '@muxr/contract';

export type HerdrLayoutNode =
    | { type: 'pane'; pane_id?: string; cwd?: string }
    | { type: 'split'; direction: 'right' | 'down'; ratio: number; first: HerdrLayoutNode; second: HerdrLayoutNode };

export function toSnapshot(node: HerdrLayoutNode, kindForPane: (paneId: string) => string | undefined): LayoutSnapshot {
    if (node.type === 'split') {
        return {
            type: 'split',
            direction: node.direction,
            ratio: node.ratio,
            first: toSnapshot(node.first, kindForPane),
            second: toSnapshot(node.second, kindForPane),
        };
    }
    const kind = node.pane_id === undefined ? undefined : kindForPane(node.pane_id);
    return {
        type: 'pane',
        ...(node.cwd === undefined ? {} : { cwd: node.cwd }),
        ...(kind === undefined ? {} : { kind }),
    };
}

/** Panes restore as plain shells; agents are started afterwards by pane id. */
export function toHerdrRoot(node: LayoutSnapshot): HerdrLayoutNode {
    if (node.type === 'split') {
        return {
            type: 'split',
            direction: node.direction,
            ratio: node.ratio,
            first: toHerdrRoot(node.first),
            second: toHerdrRoot(node.second),
        };
    }
    return { type: 'pane', ...(node.cwd === undefined ? {} : { cwd: node.cwd }) };
}

export function collectKinds(node: LayoutSnapshot, out: (string | undefined)[] = []): (string | undefined)[] {
    if (node.type === 'split') {
        collectKinds(node.first, out);
        collectKinds(node.second, out);
    } else {
        out.push(node.kind);
    }
    return out;
}

export function collectPaneIds(node: HerdrLayoutNode, out: (string | undefined)[] = []): (string | undefined)[] {
    if (node.type === 'split') {
        collectPaneIds(node.first, out);
        collectPaneIds(node.second, out);
    } else {
        out.push(node.pane_id);
    }
    return out;
}

/**
 * The entry `step` away from `currentId` in `list`, wrapping at both ends.
 * Undefined when the list has <2 entries or the current id is absent.
 */
export function neighborId<T extends string>(
    list: readonly T[],
    currentId: string,
    direction: 'next' | 'prev',
): T | undefined {
    if (list.length < 2) return undefined;
    const index = list.indexOf(currentId as T);
    if (index === -1) return undefined;
    const step = direction === 'next' ? 1 : -1;
    return list[(index + step + list.length) % list.length];
}
