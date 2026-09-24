/**
 * The workspace sheet: the home tree in a sheet, opened from the session
 * header or the Panes screen. Every workspace with the current one expanded
 * and the current pane selected; long-press closes like on home. Reads the shared live tree and
 * refreshes on open, no poller of its own.
 */
import * as React from 'react';
import { OptionSheet } from '@/components/OptionSheet';
import { sync } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { herdrTabForSession } from '../domain/agentPresentation';
import { spaceExpansionDefaults } from '../domain/herdTree';
import { useNavigateToSession } from '../application/useNavigateToSession';
import { SpacesTree } from './SpacesTree';

export function WorkspaceTreeSheet(props: { visible: boolean; sessionId?: string; onClose: () => void }): React.JSX.Element {
    const { workspaces } = useHerdrTree();
    const navigate = useNavigateToSession();
    // Opened from a session, its workspace; otherwise the desk's focused one.
    const current = props.sessionId === undefined
        ? workspaces.find((workspace) => workspace.focused)
        : herdrTabForSession(workspaces, props.sessionId)?.workspace;
    const refresh = React.useCallback(async () => { await sync.refreshHerdTree().catch(() => undefined); }, []);

    React.useEffect(() => {
        if (props.visible) void refresh();
    }, [props.visible, refresh]);

    const openPane = React.useCallback((sessionId: string) => {
        props.onClose();
        if (sessionId !== props.sessionId) navigate(sessionId);
    }, [navigate, props]);

    return (
        <OptionSheet
            visible={props.visible}
            title="Spaces"
            options={[]}
            onSelect={() => {}}
            onClose={props.onClose}
            virtualizedBody
            body={(
                <SpacesTree
                    workspaces={workspaces}
                    defaultExpandedWorkspaceIds={current === undefined ? [] : spaceExpansionDefaults(workspaces, current.workspaceId)}
                    refresh={refresh}
                    density="compact"
                    selectedSessionId={props.sessionId}
                    onNavigatePane={openPane}
                />
            )}
        />
    );
}
