import * as React from 'react';
import { useRouter } from 'expo-router';

/**
 * The live desktop, reached from the computer action on the terminal screen.
 *
 * The surface is loaded when this route is opened rather than with the
 * application: most sessions never show a desktop, and the client package's
 * session, renderer and input bridge are the largest thing in the entry graph
 * otherwise. Returning is this screen's own business — the route owns nothing
 * about the conversation underneath, so leaving it cannot disturb the session.
 */
const DesktopSurface = React.lazy(async () => {
    const desktop = await import('@/desktop');
    return { default: desktop.DesktopSurface };
});

export default function DesktopScreen() {
    const router = useRouter();
    const onExit = React.useCallback(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/');
    }, [router]);
    return (
        <React.Suspense fallback={null}>
            <DesktopSurface onExit={onExit} />
        </React.Suspense>
    );
}
