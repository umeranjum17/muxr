import * as React from 'react';
import type { Router } from 'expo-router';
import { usePathname, useRouter } from 'expo-router';
import { useSplitViewLayout } from '@/utils/responsive';

export function navigateToSession(router: Router, sessionId: string) {
    router.push(`/session/${encodeURIComponent(sessionId)}`);
}

export function useNavigateToSession() {
    const router = useRouter();
    const pathname = usePathname();
    const splitViewLayout = useSplitViewLayout();

    return React.useCallback((sessionId: string) => {
        const href = `/session/${encodeURIComponent(sessionId)}` as const;
        if (splitViewLayout && pathname.startsWith('/session/')) {
            router.replace(href);
            return;
        }
        router.push(href);
    }, [pathname, router, splitViewLayout]);
}
