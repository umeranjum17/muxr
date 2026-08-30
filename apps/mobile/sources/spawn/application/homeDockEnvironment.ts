/**
 * Home dock environment: which Agent, project path, and Worktree the
 * next spawn will use. The dock view renders these options; this module decides
 * what they are. Machine comes from the header connection, not the dock.
 */

import type { Session } from '@/catalog';
import { AGENT_TYPES, type NewSessionAgentType, type NewSessionSessionType } from '@/catalog/application/persistence';
import { formatPathRelativeToHome } from '@/herd';
import { WorktreeSelection } from '../domain/WorktreeSelection';

export interface DockOption {
    key: string;
    name: string;
    description?: string;
    agentKind?: string;
}

const AGENT_NAMES: Partial<Record<NewSessionAgentType, string>> = {
    shell: 'Shell (no agent)',
    pi: 'Pi',
    claude: 'Claude Code',
    codex: 'Codex',
    omp: 'OMP',
    opencode: 'OpenCode',
    droid: 'Factory Droid',
    qodercli: 'Qoder CLI',
};

export const DOCK_AGENTS: DockOption[] = AGENT_TYPES.map((key) => ({
    key,
    name: AGENT_NAMES[key] ?? key.replace(/(^|[-_])(\w)/g, (_, prefix, letter) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`),
    ...(key === 'shell' ? {} : { agentKind: key }),
}));

export function resolveDockOption(options: DockOption[], preferred: Array<string | null | undefined>): DockOption | null {
    for (const key of preferred) {
        const option = options.find((candidate) => candidate.key === key);
        if (option) return option;
    }
    return options[0] ?? null;
}

export function projectDockOptions(input: {
    selectedPath: string | null;
    selectedMachineId: string | null;
    sessions: readonly Session[];
    homeDir?: string;
}): DockOption[] {
    const paths = new Set<string>();
    paths.add(input.selectedPath ?? '~');
    if (input.selectedMachineId) {
        for (const session of input.sessions) {
            if (session.metadata?.machineId === input.selectedMachineId && session.metadata.path) {
                paths.add(session.metadata.path);
            }
        }
    }
    return Array.from(paths).map((path) => {
        const name = formatPathRelativeToHome(path, input.homeDir);
        return {
            key: path,
            name,
            description: name === path ? undefined : path,
        };
    });
}

export function selectedWorktreeKey(sessionType: NewSessionSessionType, worktreeKey: string | null): string {
    return new WorktreeSelection(sessionType, worktreeKey).pickerKey();
}

export function worktreeDockOptions(existing: DockOption[], worktreeKey: string | null): DockOption[] {
    const options: DockOption[] = [
        { key: '__none__', name: 'No worktree' },
        { key: '__new__', name: 'Create new worktree' },
        ...existing,
    ];
    if (worktreeKey && !options.some((option) => option.key === worktreeKey)) {
        options.push({ key: worktreeKey, name: worktreeKey });
    }
    return options;
}

export function applyWorktreeSelection(key: string): { sessionType: NewSessionSessionType; worktreeKey: string | null } {
    const selection = WorktreeSelection.fromPickerKey(key);
    return { sessionType: selection.sessionType, worktreeKey: selection.worktreeKey };
}

export function visibleDockAgents(
    hostAgentKinds: string[] | null,
    _authoritative: boolean,
    agentType: NewSessionAgentType,
): DockOption[] {
    const visibleKeys = new Set(hostAgentKinds ?? ['shell', agentType]);
    visibleKeys.add(agentType);
    return DOCK_AGENTS.filter((agent) => visibleKeys.has(agent.key));
}

export function currentDockAgent(available: DockOption[], agentType: NewSessionAgentType): DockOption {
    return available.find((agent) => agent.key === agentType) ?? available[0] ?? DOCK_AGENTS[0];
}
