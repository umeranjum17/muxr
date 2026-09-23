import { expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

const reads = vi.hoisted(() => [] as Array<(value: { text: string }) => void>);
vi.mock('@/catalog/sync', () => ({
    sync: { request: () => new Promise<{ text: string }>((resolve) => reads.push(resolve)) },
}));
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text',
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/constants/Typography', () => ({ Typography: { mono: () => ({}) } }));

import { refreshPaneSnapshot, usePaneSnapshot } from './paneSnapshots';
import { TerminalPreview } from '../presentation/TerminalPreview';

function SnapshotText() {
    return <>{usePaneSnapshot('pane-order-flow')}</>;
}

it('keeps the latest accepted pane read in the tile and pager when replies cross', async () => {
    let renderer: ReturnType<typeof TestRenderer.create> | undefined;
    TestRenderer.act(() => {
        renderer = TestRenderer.create(<><TerminalPreview sessionId="pane-order-flow" live={false} /><SnapshotText /></>);
    });
    expect(reads).toHaveLength(1);
    const refresh = refreshPaneSnapshot('pane-order-flow');
    expect(reads).toHaveLength(2);
    await TestRenderer.act(async () => {
        reads[1]!({ text: 'new screen' });
        await refresh;
    });
    await TestRenderer.act(async () => {
        reads[0]!({ text: 'old screen' });
        await Promise.resolve();
    });
    expect(renderer!.root.findByType('Text').props.children).toBe('new screen');
    expect(renderer!.root.findByType(SnapshotText).children).toEqual(['new screen']);
    TestRenderer.act(() => renderer!.unmount());
});
