import * as React from 'react';
import { useAllMachines } from '@/sync/storage';
import { useNavigateToSession } from '@/herd';
import { startSessionFromDraft } from './startSessionFromDraft';

export function useStartSessionFromDraft() {
    const machines = useAllMachines({ includeOffline: true });
    const navigateToSession = useNavigateToSession();
    const [isStarting, setIsStarting] = React.useState(false);
    const isStartingRef = React.useRef(false);

    const startSession = React.useCallback(async ({ blank = false }: { blank?: boolean } = {}): Promise<string | null> => {
        if (isStartingRef.current) return null;
        isStartingRef.current = true;
        setIsStarting(true);
        try {
            return await startSessionFromDraft({ machines, navigateToSession, blank });
        } finally {
            isStartingRef.current = false;
            setIsStarting(false);
        }
    }, [machines, navigateToSession]);

    return { isStarting, startSession };
}
