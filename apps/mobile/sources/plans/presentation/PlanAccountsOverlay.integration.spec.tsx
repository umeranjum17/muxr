import React from 'react';
import TestRenderer from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    View: (props: Record<string, unknown>) =>
        React.createElement('View', props, props.children as React.ReactNode),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
    ScopedTheme: (props: Record<string, unknown>) =>
        React.createElement(React.Fragment, null, props.children as React.ReactNode),
    StyleSheet: { absoluteFill: {} },
}));
const stubs = vi.hoisted(() => ({
    AddAccountSheet: () => null,
    NameAccountSheet: () => null,
    SignInBanner: () => null,
    Notice: () => null,
    MoveSheet: () => null,
}));
vi.mock('./AccountFlows', () => ({
    AddAccountSheet: stubs.AddAccountSheet,
    NameAccountSheet: stubs.NameAccountSheet,
    Notice: stubs.Notice,
    SignInBanner: stubs.SignInBanner,
}));
vi.mock('./MoveAccount', () => ({ MoveSheet: stubs.MoveSheet }));

import { dismissNotice, showNotice, useNotice } from '../application/planNotices';
import { PlanAccountsOverlay } from './PlanAccountsOverlay';

let rendered: ReturnType<typeof TestRenderer.create> | undefined;

afterEach(() => {
    if (rendered !== undefined) TestRenderer.act(() => rendered?.unmount());
    rendered = undefined;
    dismissNotice();
    expect(useNotice.getState().notice).toBeNull();
});

// The account notice lives only on the Accounts screen, in the list's own
// layout flow. The overlay beside the navigator renders no banner, so a
// notice raised while an agent screen is open never renders over the
// terminal — and the terminal layout never changes.
it('renders no account banner beside any screen while a notice is live', () => {
    showNotice('Added Umer', 'Umer · OpenCode account');
    expect(useNotice.getState().notice).not.toBeNull();
    TestRenderer.act(() => {
        rendered = TestRenderer.create(<PlanAccountsOverlay />);
    });
    const count = (type: () => null) =>
        (rendered!.root as unknown as { findAllByType(type: () => null): unknown[] }).findAllByType(type).length;
    expect(count(stubs.Notice)).toBe(0);
    // The overlay still mounts the rest of the account flows.
    expect(count(stubs.SignInBanner)).toBe(1);
    expect(count(stubs.AddAccountSheet)).toBe(1);
    expect(count(stubs.NameAccountSheet)).toBe(1);
    expect(count(stubs.MoveSheet)).toBe(1);
});
