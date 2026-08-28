import type { SessionListViewItem, SessionRowData } from '@/sync/storage';

export interface SessionDisplayMachine {
    id: string;
    metadata?: {
        displayName?: string | null;
        host?: string | null;
    } | null;
}

/**
 * One level below a project: a herdr tab, or a worktree checkout of the repo.
 * `label` is null when there is nothing worth showing (a single unnamed tab),
 * so the common one-agent project does not grow a pointless nesting row.
 */
export interface ActiveSessionDisplaySubgroup {
    key: string;
    label: string | null;
    isWorktree: boolean;
    sessions: SessionRowData[];
}

export interface ActiveSessionDisplayProject {
    displayPath: string;
    subgroups: ActiveSessionDisplaySubgroup[];
    /** Flat, subgroup-ordered list. Keyboard shortcut ordering reads this. */
    sessions: SessionRowData[];
}

export interface ActiveSessionDisplayMachineGroup {
    machineId: string;
    machineName: string;
    projects: Map<string, ActiveSessionDisplayProject>;
}

export function formatSessionDisplayPath(path: string, homeDir?: string): string {
    if (!homeDir) {
        return path;
    }
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    if (!path.startsWith(normalizedHome)) {
        return path;
    }
    const relativePath = path.slice(normalizedHome.length);
    if (relativePath.startsWith('/')) {
        return `~${relativePath}`;
    }
    return relativePath === '' ? '~' : `~/${relativePath}`;
}

export function buildActiveSessionDisplayGroups(
    sessions: readonly SessionRowData[],
    machines: readonly SessionDisplayMachine[],
    unknownText: string,
): ActiveSessionDisplayMachineGroup[] {
    const machinesMap = new Map(machines.map((machine) => [machine.id, machine]));
    const byMachine = new Map<string, ActiveSessionDisplayMachineGroup>();

    // Groups follow herdr's physical topology only: workspace (folding linked
    // worktrees under their repo), then tab. We tried grouping by spawn lineage
    // and it pulled agents out of the workspace they live in -- a worktree
    // session landed under an unrelated repo while its workspace-mates stayed
    // behind, which read as chaos. Lineage is shown as a row badge instead.
    sessions.forEach((session) => {
        const machineId = session.machineId || unknownText;
        const machine = machineId !== unknownText ? machinesMap.get(machineId) : null;
        const machineName = machine?.metadata?.displayName
            || machine?.metadata?.host
            || (machineId !== unknownText ? machineId : `<${unknownText}>`);

        let machineGroup = byMachine.get(machineId);
        if (!machineGroup) {
            machineGroup = { machineId, machineName, projects: new Map() };
            byMachine.set(machineId, machineGroup);
        }

        // herdr already knows what belongs together: a worktree workspace and
        // its parent repo share a repo name, and panes spawned by a split share
        // a tab. Grouping by cwd threw both away and showed siblings as
        // unrelated projects.
        // ponytail: folds by repo NAME, not repo_key -- two repos with the same
        // basename would merge. Plumb worktree.repo_key through if that bites.
        const projectKey = session.worktreeRepo || session.workspaceLabel || session.path || '';
        let projectGroup = machineGroup.projects.get(projectKey);
        if (!projectGroup) {
            projectGroup = {
                displayPath:
                    session.worktreeRepo
                    ?? session.workspaceLabel
                    ?? formatSessionDisplayPath(projectKey, session.homeDir ?? undefined),
                subgroups: [],
                sessions: [],
            };
            machineGroup.projects.set(projectKey, projectGroup);
        }

        const isWorktree = session.worktreeRepo !== null && session.worktreeRepo !== undefined;
        const subKey = isWorktree
            ? `wt:${session.workspaceId ?? session.path ?? ''}`
            : `tab:${session.tabId ?? ''}`;
        let subgroup = projectGroup.subgroups.find((entry) => entry.key === subKey);
        if (!subgroup) {
            subgroup = {
                key: subKey,
                label: isWorktree
                    ? (session.worktreeBranch ?? session.workspaceLabel ?? null)
                    : (session.tabLabel ?? null),
                isWorktree,
                sessions: [],
            };
            projectGroup.subgroups.push(subgroup);
        }
        subgroup.sessions.push(session);
    });

    byMachine.forEach((machineGroup) => {
        machineGroup.projects.forEach((projectGroup) => {
            for (const subgroup of projectGroup.subgroups) {
                subgroup.sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            }
            // A lone unnamed tab is noise; a lone tab herdr named is still worth
            // showing, because that name is how the user refers to it.
            if (projectGroup.subgroups.length === 1 && !projectGroup.subgroups[0].isWorktree) {
                const only = projectGroup.subgroups[0];
                if (only.label === null || /^\d+$/.test(only.label)) only.label = null;
            }
            projectGroup.sessions = projectGroup.subgroups.flatMap((entry) => entry.sessions);
        });
    });

    return Array.from(byMachine.values()).sort((a, b) =>
        a.machineName.localeCompare(b.machineName)
    );
}

export function getSessionShortcutIdsInDisplayOrder(
    data: readonly SessionListViewItem[] | null,
    machines: readonly SessionDisplayMachine[],
    unknownText: string,
): string[] {
    if (!data) {
        return [];
    }

    const sessionIds: string[] = [];
    data.forEach((item) => {
        if (item.type === 'active-sessions') {
            const machineGroups = buildActiveSessionDisplayGroups(item.sessions, machines, unknownText);
            machineGroups.forEach((machineGroup) => {
                Array.from(machineGroup.projects.values())
                    .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
                    .forEach((projectGroup) => {
                        projectGroup.sessions.forEach((session) => sessionIds.push(session.id));
                    });
            });
        } else if (item.type === 'session') {
            sessionIds.push(item.session.id);
        }
    });

    return sessionIds.slice(0, 9);
}
