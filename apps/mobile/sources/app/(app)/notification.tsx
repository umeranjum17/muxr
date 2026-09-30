import * as React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getCachedConnectionSettings } from '@/connection';
import { navigateToSession, watchAgentLifecycle } from '@/herd';

export default function NotificationRoute() {
    const { machineId, sessionId } = useLocalSearchParams<{ machineId?: string; sessionId?: string }>();
    const router = useRouter();
    React.useEffect(() => {
        if (typeof machineId !== 'string' || machineId === '' || typeof sessionId !== 'string' || sessionId === '') {
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
    }, [machineId, sessionId, router]);
    return null;
}
