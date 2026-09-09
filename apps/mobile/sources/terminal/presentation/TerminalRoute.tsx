import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { router } from 'expo-router';
import { getCachedConnectionSettings } from '@/connection';
import { useHerdrTree } from '@/catalog/store';
import { TerminalScreen } from './TerminalScreen';

/** Keep an open terminal on its pane when an agent starts, exits or restarts. */
export function TerminalRoute({ id }: { id: string }): React.JSX.Element {
    const focused = useIsFocused();
    const { workspaces } = useHerdrTree();
    const machineId = getCachedConnectionSettings().machineId;
    const binding = React.useRef<{ machineId: string; route: string; paneId: string } | null>(null);
    const panes = workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes));
    const live = panes.find((pane) => pane.sessionId === id);
    const remembered = binding.current;
    let currentId = id;
    if (focused && live === undefined && remembered?.machineId === machineId && remembered.route === id) {
        const samePane = panes.filter((pane) => pane.paneId === remembered.paneId);
        if (samePane.length === 1 && samePane[0]?.sessionId) currentId = samePane[0].sessionId;
    }

    React.useEffect(() => {
        // Bind only after observing this route live. A historical route must
        // never redirect to an unrelated agent that reused a stored pane id.
        if (live !== undefined) binding.current = { machineId, route: id, paneId: live.paneId };
        else if (binding.current?.machineId !== machineId || binding.current.route !== id) binding.current = null;
    }, [id, machineId, live?.paneId]);
    React.useEffect(() => {
        if (focused && currentId !== id) router.replace(`/session/${encodeURIComponent(currentId)}`);
    }, [id, currentId, focused]);

    // A new route needs a fresh native surface/layout callback and channel.
    // Reusing the view resets its attach refs without changing native size,
    // leaving it waiting for a size event that may never happen.
    return <TerminalScreen key={`${machineId}:${currentId}`} id={currentId} />;
}
