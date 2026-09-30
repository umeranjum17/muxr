import * as React from 'react';
import { useRouter } from 'expo-router';
import { getCachedConnectionSettings } from '@/connection';
import { navigateToSession, watchAgentLifecycle } from '@/herd';

export default function NotificationRoute() {
    const router = useRouter();
    React.useEffect(() => {
        if (typeof window === 'undefined') {
            router.replace('/');
            return;
        }
        const openNotification = () => {
            const params = new URLSearchParams(window.location.hash.slice(1));
            const machineId = params.get('machineId');
            const sessionId = params.get('sessionId');
            window.history.replaceState(window.history.state, '', window.location.pathname);
            if (!machineId || !sessionId) {
                router.replace('/');
                return;
            }
            const target = watchAgentLifecycle({
                notificationData: { machineId, sessionId },
                activeMachineId: getCachedConnectionSettings().machineId,
            });
            if (target.selectMachine) router.replace('/settings');
            else if (target.agentRoute !== null) navigateToSession(router, target.agentRoute);
            else router.replace('/');
        };
        window.addEventListener('hashchange', openNotification);
        openNotification();
        return () => window.removeEventListener('hashchange', openNotification);
    }, [router]);
    return null;
}
