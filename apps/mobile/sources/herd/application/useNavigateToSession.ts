import * as React from 'react';
import type { Router } from 'expo-router';
import { usePathname, useRouter } from 'expo-router';
import { useSplitViewLayout } from '@/utils/responsive';
import { focusAgent } from './FocusAgent';

export function navigateToSession(router: Router, sessionId: string) {
    const { href } = focusAgent({ agentRoute: sessionId });
    router.push(href);
}

export function useNavigateToSession() {
    const router = useRouter();
    const pathname = usePathname();
    const splitViewLayout = useSplitViewLayout();

    return React.useCallback((sessionId: string) => {
        const focused = focusAgent({
            agentRoute: sessionId,
            alreadyViewingAgent: pathname.startsWith('/session/'),
            splitView: splitViewLayout,
        });
        if (focused.replace) {
            router.replace(focused.href);
            return;
        }
        router.push(focused.href);
    }, [pathname, router, splitViewLayout]);
}
