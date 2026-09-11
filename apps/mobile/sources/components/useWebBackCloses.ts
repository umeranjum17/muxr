import * as React from 'react';
import { Platform } from 'react-native';

/**
 * On web, a sheet or menu owns one history entry while open, so browser Back
 * closes it instead of leaving the route (the same dummy-entry trick the
 * HomeDock focus mode uses). Escape closes it too, and focus returns to
 * whatever opened it. Closing by any other means consumes the entry so one
 * Back never needs two presses.
 */
export function useWebBackCloses(open: boolean, onClose: () => void, tag: string): void {
    const pushedRef = React.useRef(false);
    const returnToRef = React.useRef<{ focus?: () => void } | null>(null);
    const closeRef = React.useRef(onClose);
    closeRef.current = onClose;

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !open) return;
        returnToRef.current = (document.activeElement as { focus?: () => void } | null) ?? null;
        const routerId = (window.history.state as { id?: unknown } | null)?.id;
        window.history.pushState({ ...(typeof routerId === 'string' ? { id: routerId } : {}), [tag]: true }, '');
        pushedRef.current = true;
        const onPopState = () => {
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
                window.history.back();
            }
            pushedRef.current = false;
            const returnTo = returnToRef.current;
            returnToRef.current = null;
            if (typeof returnTo?.focus === 'function') setTimeout(() => returnTo.focus?.(), 0);
        };
    }, [open, tag]);
}
