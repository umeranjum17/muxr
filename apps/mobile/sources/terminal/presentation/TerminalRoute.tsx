import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { router } from 'expo-router';
import { getCachedConnectionSettings } from '@/connection';
import { useHerdrTree, useLifecycleEvents, useSessionError } from '@/catalog/store';
import { useActivityAcknowledgements } from '@/herd';
import { agentOnScreen } from '@/watch/lifecycleAlert';
import { TerminalScreen } from './TerminalScreen';

/** Follow the pane across agent changes, unless a failed route must stay open to explain its error. */
export function TerminalRoute({ id, desktop = false, preview = false }: { id: string; desktop?: boolean; preview?: boolean }): React.JSX.Element {
    const focused = useIsFocused();
    const { workspaces } = useHerdrTree();
    const sessionError = useSessionError(id);
    const lifecycleEvents = useLifecycleEvents();
    const { ready, seenEventIds, markSeen } = useActivityAcknowledgements();
    const machineId = getCachedConnectionSettings().machineId;
    const binding = React.useRef<{ machineId: string; route: string; paneId: string } | null>(null);
    const panes = workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes));
    const live = panes.find((pane) => pane.sessionId === id);
    const remembered = binding.current;
    let currentId = id;
    if (focused && sessionError === undefined && live === undefined && remembered?.machineId === machineId && remembered.route === id) {
        const samePane = panes.filter((pane) => pane.paneId === remembered.paneId);
        if (samePane.length === 1 && samePane[0]?.sessionId) currentId = samePane[0].sessionId;
    }

    React.useEffect(() => {
        // Bind only after observing this route live. A historical route must
        // never redirect to an unrelated agent that reused a stored pane id.
        if (live !== undefined) binding.current = { machineId, route: id, paneId: live.paneId };
        else if (binding.current?.machineId !== machineId || binding.current.route !== id) binding.current = null;
    }, [id, machineId, live?.paneId]);
    // Opening the agent is what "looked at its finished outcome" means. This is
    // the single ack point for done events, so the READY · UNSEEN tier clears
    // no matter which path opened the agent (tier row, live card, spaces tree,
    // deep link).
    React.useEffect(() => {
        if (!focused || !ready) return;
        const unseen = lifecycleEvents
            .filter((event) => event.sessionId === id && event.state === 'done' && !seenEventIds.has(event.eventId))
            .map((event) => event.eventId);
        if (unseen.length > 0) markSeen(unseen);
    }, [focused, ready, id, lifecycleEvents, seenEventIds, markSeen]);
    React.useEffect(() => {
        if (focused && currentId !== id) router.replace(`/session/${encodeURIComponent(currentId)}`);
    }, [id, currentId, focused]);
    // The terminal in front already shows this agent; an alert for it is noise.
    React.useEffect(() => (focused ? agentOnScreen(currentId) : undefined), [focused, currentId]);

    // A new route needs a fresh native surface/layout callback and channel.
    // Reusing the view resets its attach refs without changing native size,
    // leaving it waiting for a size event that may never happen.
    return <TerminalScreen key={`${machineId}:${currentId}`} id={currentId} desktop={desktop} preview={preview} />;
}
