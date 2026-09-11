import * as React from 'react';
import { Platform } from 'react-native';

/**
 * On web, a sheet or menu owns one history entry while open, so browser Back
 * closes it instead of leaving the route (the same dummy-entry trick the
 * HomeDock focus mode uses). Escape closes it too, and focus returns to
 * whatever opened it.
 *
 * Closing by other means (a selection, Escape) cannot pop the entry with
 * history.back(): traversal settles asynchronously, and a selection that
 * navigates right after would have its new route popped instead. The entry
 * is left in place as a duplicate of the route beneath it, and the next Back
 * that lands on such a duplicate is forwarded one more step, so one press
 * still leaves the route.
 */
let duplicates = 0;
let duplicateId: string | undefined;
let forwarding = false;

function routerId(): string | undefined {
    const id = (window.history.state as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : undefined;
}

function watchDuplicates(): void {
    if (forwarding) return;
    forwarding = true;
    window.addEventListener('popstate', () => {
        const id = routerId();
        if (duplicates === 0 || id === undefined || id !== duplicateId) {
            duplicates = 0;
            return;
        }
        const state = window.history.state as Record<string, unknown> | null;
        if (state !== null && Object.keys(state).some((key) => key !== 'id')) return;
        duplicates -= 1;
        window.history.back();
    });
}

export function useWebBackCloses(open: boolean, onClose: () => void, tag: string): void {
    const pushedRef = React.useRef(false);
    const returnToRef = React.useRef<{ focus?: () => void } | null>(null);
    const closeRef = React.useRef(onClose);
    closeRef.current = onClose;

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !open) return;
        watchDuplicates();
        returnToRef.current = (document.activeElement as { focus?: () => void } | null) ?? null;
        const id = routerId();
        window.history.pushState({ ...(id === undefined ? {} : { id }), [tag]: true }, '');
        pushedRef.current = true;
        const onPopState = () => {
            // Only a pop that leaves this entry closes; a deeper sheet popping
            // back onto it must not.
            if ((window.history.state as Record<string, unknown> | null)?.[tag] === true) return;
            pushedRef.current = false;
            closeRef.current();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            // Claim the key: the global Escape-goes-back shortcut honours
            // defaultPrevented, and the topmost sheet must win over the route.
            event.preventDefault();
            closeRef.current();
        };
        window.addEventListener('popstate', onPopState);
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => {
            window.removeEventListener('popstate', onPopState);
            window.removeEventListener('keydown', onKeyDown, { capture: true });
            if (pushedRef.current && (window.history.state as Record<string, unknown> | null)?.[tag] === true) {
                window.history.replaceState(id === undefined ? null : { id }, '');
                if (id !== undefined) {
                    duplicates = duplicateId === id ? duplicates + 1 : 1;
                    duplicateId = id;
                }
            }
            pushedRef.current = false;
            const returnTo = returnToRef.current;
            returnToRef.current = null;
            if (typeof returnTo?.focus === 'function') setTimeout(() => returnTo.focus?.(), 0);
        };
    }, [open, tag]);
}
