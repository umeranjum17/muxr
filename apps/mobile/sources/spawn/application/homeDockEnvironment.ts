/**
 * Home dock environment: which Agent, project path, and Worktree the
 * next spawn will use. The dock view renders these options; this module decides
 * what they are. Machine comes from the header connection, not the dock.
 */

import type { Session } from '@/catalog';
import { AGENT_TYPES, type NewSessionAgentType, type NewSessionSessionType, type AgentCatalogOption } from '@/catalog';
import { formatPathRelativeToHome } from '@/herd';
import { agentDisplayName } from '../domain/SpawnRequest';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import { listWorktrees } from './worktree';

export interface DockOption {
    key: string;
    name: string;
    description?: string;
    agentKind?: string;
    installPhase?: string;
    disabled?: boolean;
}

export const DOCK_AGENTS: DockOption[] = AGENT_TYPES.map((key) => ({
    key,
    name: agentDisplayName(key),
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

/** Worktrees that already exist on the machine, as dock options. */
export async function listWorktreeOptions(machineId: string, path: string): Promise<DockOption[]> {
    const worktrees = await listWorktrees(machineId, path);
    return worktrees.map((worktree) => ({
        key: worktree.path,
        name: worktree.branch,
        description: worktree.path,
    }));
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

export function agentName(kind: string): string {
    return agentDisplayName(kind);
}

/** The kit's install probe says a kind installs on first start (its CLI is a Herdr-managed auto-installer, e.g. Pi through mise). */
function installsOnFirstStart(option: AgentCatalogOption): boolean {
    return option.availability === 'installed' && option.installState === 'installs-on-first-start';
}

export function agentReadinessLabel(option: AgentCatalogOption, launching = false): string {
    if (option.kind === 'shell') return 'Ready';
    if (launching && installsOnFirstStart(option)) return `Installing ${agentName(option.kind)}`;
    if (option.availability !== 'installed') {
        return option.installHint ?? `Install ${agentName(option.kind)} on the computer`;
    }
    if (option.signedIn === 'yes') return 'Signed in';
    if (option.signedIn === 'no') return 'Needs sign-in';
    return 'Sign-in not checked';
}

/** The Start control's phase while a first-start installer runs, or undefined to keep the normal control. */
export function agentInstallPhase(option: AgentCatalogOption | undefined): string | undefined {
    if (option === undefined || !installsOnFirstStart(option)) return undefined;
    return agentReadinessLabel(option, true);
}

export function defaultAgentKind(options: readonly AgentCatalogOption[], preferred?: string): string | null {
    const signedIn = options.filter((option) => option.availability === 'installed' && option.signedIn === 'yes' && option.kind !== 'pi');
    return signedIn.find((option) => option.kind === preferred)?.kind ?? signedIn[0]?.kind ?? null;
}

export function visibleDockAgents(options: readonly AgentCatalogOption[] | null, more = false): DockOption[] {
    const agents = (options ?? []).filter((option) => (option.availability === 'installed') !== more).map((option) => ({
        key: option.kind,
        name: agentName(option.kind),
        description: [agentReadinessLabel(option), option.availability === 'installed' ? option.signInHint : undefined].filter(Boolean).join(' · '),
        agentKind: option.kind,
        installPhase: agentInstallPhase(option),
        disabled: more,
    }));
    if (more) return agents;
    return [...agents, { key: 'shell', name: 'Shell (no agent)', description: 'Ready' }];
}

export function currentDockAgent(available: DockOption[], agentType: NewSessionAgentType): DockOption {
    return available.find((agent) => agent.key === agentType) ?? available[0] ?? DOCK_AGENTS[0];
}
