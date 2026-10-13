import * as React from 'react';
import { useAllMachines } from '@/catalog/store';
import { useNavigateToSession } from '@/herd';
import { startSessionFromDraft } from './startSessionFromDraft';
import type { FirstPromptFailure } from './StartAgentFromDock';

export function useStartSessionFromDraft() {
    const machines = useAllMachines({ includeOffline: true });
    const navigateToSession = useNavigateToSession();
    const [isStarting, setIsStarting] = React.useState(false);
    const isStartingRef = React.useRef(false);

    const startSession = React.useCallback(async ({ blank = false, onRouteReady, onPromptFailed }: { blank?: boolean; onRouteReady?: (agentRoute: string) => void; onPromptFailed?: (failure: FirstPromptFailure) => void } = {}): Promise<string | null> => {
        if (isStartingRef.current) return null;
        isStartingRef.current = true;
        setIsStarting(true);
        try {
            return await startSessionFromDraft({ machines, navigateToSession, blank, onRouteReady, onPromptFailed });
        } finally {
            isStartingRef.current = false;
            setIsStarting(false);
        }
    }, [machines, navigateToSession]);

    return { isStarting, startSession };
}
