import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { storage, useHerdrTree } from '@/catalog/store';
import { sync } from '@/catalog/sync';
import { listPairedGrants } from '@/pairing/e2ee';
import { hasAgent } from '../domain/herdTree';

export function useHerdTreeLive() {
    const { workspaces, loaded } = useHerdrTree();
    const [attempted, setAttempted] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [herdrConnected, setHerdrConnected] = React.useState<boolean | undefined>(undefined);
    const [hasPairedGrant, setHasPairedGrant] = React.useState<boolean | undefined>(undefined);

    React.useEffect(() => {
        let cancelled = false;
        void listPairedGrants().then((grants) => {
            if (!cancelled) setHasPairedGrant(grants.length > 0);
        });
        return () => { cancelled = true; };
    }, []);

    const refresh = React.useCallback(async () => {
        try {
            const result = await sync.refreshHerdTree();
            setHerdrConnected(result.herdrConnected);
            setError(null);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setAttempted(true);
        }
    }, []);

    useFocusEffect(
        React.useCallback(() => {
            void refresh();
            const interval = setInterval(() => void refresh(), 5_000);
            return () => clearInterval(interval);
        }, [refresh]),
    );

    const debounceRef = React.useRef<number | NodeJS.Timeout | undefined>(undefined);
    React.useEffect(() => {
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.sessions === previous.sessions) return;
            clearTimeout(debounceRef.current);
            // A busy herd writes sessions constantly, and each write used to pull
            // the whole tree a second later; on a hundred panes that is a large
            // decrypt, parse and deep-compare for placement that rarely moves.
            debounceRef.current = setTimeout(() => void refresh(), 3_000);
        });
        return () => {
            unsubscribe();
            clearTimeout(debounceRef.current);
        };
    }, [refresh]);

    const defaultExpandedWorkspaceIds = React.useMemo(
        () => workspaces.filter(hasAgent).map((workspace) => workspace.workspaceId),
        [workspaces],
    );

    return {
        workspaces,
        loaded,
        attempted,
        error,
        herdrConnected,
        hasPairedGrant,
        defaultExpandedWorkspaceIds,
        refresh,
    };
}
