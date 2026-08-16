// react-test-renderer 19 ships no bundled types and has no @types package;
// the spec needs only create/act/unmount to exercise the dictation hook.
declare module 'react-test-renderer' {
    import type { ReactElement } from 'react';

    interface ReactTestRenderer {
        root: unknown;
        update(element: ReactElement): void;
        unmount(): void;
    }

    interface TestRendererModule {
        create(element: ReactElement): ReactTestRenderer;
        act(callback: () => Promise<void> | void): Promise<void> | void;
    }

    const TestRenderer: TestRendererModule;
    export default TestRenderer;
}
