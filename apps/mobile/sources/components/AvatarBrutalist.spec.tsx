import { afterAll, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';

/*
 * Metro maps every PNG require to a distinct asset reference. Node has no
 * such loader, so stub each image path to a distinct opaque value before the
 * component module evaluates. Distinctness is the whole point: the shape must
 * still tell sessions apart now that colour no longer does.
 */
const originalLoad = (Module as unknown as { _load: unknown })._load as (...args: unknown[]) => unknown;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (request: unknown, ...rest: unknown[]) {
    if (typeof request === 'string' && request.endsWith('.png')) return { uri: request };
    return (originalLoad as (...args: unknown[]) => unknown).call(this, request, ...rest);
};
afterAll(() => {
    (Module as unknown as { _load: unknown })._load = originalLoad;
});

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { accent: '#111111', textSecondary: '#222222', surfaceHighest: '#333333' } },
    }),
}));

const { AvatarBrutalist } = await import('@/components/AvatarBrutalist');

/** Rendered colours and shape for one avatar; the observable output of the component. */
function rendered(id: string, monochrome = false) {
    let renderer: any;
    act(() => {
        renderer = TestRenderer.create(<AvatarBrutalist id={id} monochrome={monochrome} />);
    });
    const root = renderer!.root;
    const image = root.findByType('Image' as never);
    const view = root.findByType('View' as never);
    const imageProps = image.props as { tintColor: string; source: unknown };
    const viewProps = view.props as { style: { backgroundColor: string } };
    return { tintColor: imageProps.tintColor, backgroundColor: viewProps.style.backgroundColor, source: imageProps.source };
}

/** The retired per-session palette: loud tints on loud backgrounds. No avatar may render these. */
const retiredColours = new Set(
    '#FFA617 #0056B3 #59C9DF #DC2626 #C678FF #16A34A #FF79D7 #047857 #FFD800 #4C1D95 #84E600 #C026D3'.split(' '),
);

describe('AvatarBrutalist ink-drop recolour', () => {
    it('gives different session ids different avatar shapes', () => {
        const ids = Array.from({ length: 20 }, (_, index) => `session-${index}`);
        const shapes = new Set(ids.map((id) => JSON.stringify(rendered(id).source)));
        expect(shapes.size).toBeGreaterThanOrEqual(15);
    });

    it('never renders a retired loud colour for any session id', () => {
        const ids = Array.from({ length: 100 }, (_, index) => `probe-${index}`);
        for (const id of ids) {
            const plain = rendered(id);
            expect(plain.tintColor).toBe('#111111');
            expect(plain.backgroundColor).toBe('#333333');
            expect(retiredColours.has(plain.tintColor)).toBe(false);
            expect(retiredColours.has(plain.backgroundColor)).toBe(false);

            const mono = rendered(id, true);
            expect(mono.tintColor).toBe('#222222');
            expect(mono.backgroundColor).toBe('#333333');
            expect(retiredColours.has(mono.tintColor)).toBe(false);
            expect(retiredColours.has(mono.backgroundColor)).toBe(false);
        }
    });
});
