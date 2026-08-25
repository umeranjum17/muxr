import * as React from 'react';
import { t } from '@/text';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useAllMachines, useSessions, useSocketStatus } from '@/sync/storage';
import { AGENT_TYPES, type NewSessionAgentType } from '@/sync/persistence';
import type { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveAgentCatalog } from '@/sync/agentKinds';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { formatLastSeen, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { listWorktrees } from '@/utils/worktree';

export interface HomeDockOption {
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

export const HOME_DOCK_AGENTS: HomeDockOption[] = AGENT_TYPES.map((key) => ({
    key,
    name: AGENT_NAMES[key] ?? key.replace(/(^|[-_])(\w)/g, (_, prefix, letter) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`),
    ...(key === 'shell' ? {} : { agentKind: key }),
}));

function resolveOption(options: HomeDockOption[], preferred: Array<string | null | undefined>): HomeDockOption | null {
    for (const key of preferred) {
        const option = options.find((candidate) => candidate.key === key);
        if (option !== undefined) return option;
    }
    return options[0] ?? null;
}

export function useHomeDockEnvironment() {
    const agentType = useNewSessionDraft((state) => state.agentType);
    const selectedMachineId = useNewSessionDraft((state) => state.selectedMachineId);
    const selectedPath = useNewSessionDraft((state) => state.selectedPath);
    const sessionType = useNewSessionDraft((state) => state.sessionType);
    const worktreeKey = useNewSessionDraft((state) => state.worktreeKey);
    const setMachineId = useNewSessionDraft((state) => state.setMachineId);
    const setAgentType = useNewSessionDraft((state) => state.setAgentType);
    const setPath = useNewSessionDraft((state) => state.setPath);
    const setSessionType = useNewSessionDraft((state) => state.setSessionType);
    const setWorktreeKey = useNewSessionDraft((state) => state.setWorktreeKey);
    const socketStatus = useSocketStatus();
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    const [hostAgentKinds, setHostAgentKinds] = React.useState<string[] | null>(null);
    const [hostAgentKindsAuthoritative, setHostAgentKindsAuthoritative] = React.useState(false);
    const [existingWorktrees, setExistingWorktrees] = React.useState<HomeDockOption[]>([]);

    const selectedMachine = React.useMemo(
        () => machines.find((machine) => machine.id === selectedMachineId) ?? null,
        [machines, selectedMachineId],
    );
    const machineOptions = React.useMemo<HomeDockOption[]>(() => (
        [...machines]
            .sort((left, right) => Number(isMachineOnline(right)) - Number(isMachineOnline(left)))
            .map((machine) => ({
                key: machine.id,
                name: machine.metadata?.displayName || machine.metadata?.host || 'Unknown machine',
                description: isMachineOnline(machine)
                    ? t('status.online')
                    : t('status.lastSeen', { time: formatLastSeen(machine.activeAt, false) }),
            }))
    ), [machines]);
    const currentMachine = resolveOption(machineOptions, [selectedMachineId]);

    React.useEffect(() => {
        if ((selectedMachineId === null || selectedMachineId === '') && machineOptions[0] !== undefined) {
            setMachineId(machineOptions[0].key);
        }
    }, [machineOptions, selectedMachineId, setMachineId]);

    const projectOptions = React.useMemo<HomeDockOption[]>(() => {
        const paths = new Set<string>([selectedPath ?? '~']);
        if (selectedMachineId !== null && selectedMachineId !== '' && sessions !== null) {
            for (const item of sessions) {
                if (typeof item === 'string') continue;
                const session = item as Session;
                if (session.metadata?.machineId === selectedMachineId && session.metadata.path) paths.add(session.metadata.path);
            }
        }
        const homeDir = selectedMachine?.metadata?.homeDir;
        return Array.from(paths).map((path) => {
            const name = formatPathRelativeToHome(path, homeDir);
            return { key: path, name, ...(name === path ? {} : { description: path }) };
        });
    }, [selectedMachine, selectedMachineId, selectedPath, sessions]);
    const currentProject = resolveOption(projectOptions, [selectedPath, '~']);
    const selectedWorktreeKey = sessionType === 'worktree' ? worktreeKey ?? '__new__' : '__none__';

    React.useEffect(() => {
        const path = resolveAbsolutePath(selectedPath ?? '~', selectedMachine?.metadata?.homeDir);
        if (selectedMachineId === null || selectedMachineId === '' || selectedMachine === null || !isMachineOnline(selectedMachine) || path === '') {
            setExistingWorktrees([]);
            return;
        }
        let cancelled = false;
        void listWorktrees(selectedMachineId, path).then((worktrees) => {
            if (!cancelled) {
                setExistingWorktrees(worktrees.map((worktree) => ({
                    key: worktree.path,
                    name: worktree.branch,
                    description: worktree.path,
                })));
            }
        });
        return () => { cancelled = true; };
    }, [selectedMachine, selectedMachineId, selectedPath]);

    const worktreeOptions = React.useMemo<HomeDockOption[]>(() => {
        const options: HomeDockOption[] = [
            { key: '__none__', name: 'No worktree' },
            { key: '__new__', name: 'Create new worktree' },
            ...existingWorktrees,
        ];
        if (worktreeKey !== null && worktreeKey !== '' && !options.some((option) => option.key === worktreeKey)) {
            options.push({ key: worktreeKey, name: worktreeKey });
        }
        return options;
    }, [existingWorktrees, worktreeKey]);
    const currentWorktree = resolveOption(worktreeOptions, [selectedWorktreeKey]);

    React.useEffect(() => {
        let cancelled = false;
        setHostAgentKinds(null);
        setHostAgentKindsAuthoritative(false);
        if (socketStatus.status !== 'connected') return () => { cancelled = true; };
        void sync.request('herdr.agentKinds', {}).then((result) => {
            if (cancelled) return;
            const resolved = resolveAgentCatalog(result);
            const launchable = resolved.options
                .filter((option) => option.availability !== 'unavailable')
                .map((option) => option.kind);
            setHostAgentKinds([...new Set(['shell', ...launchable])]);
            setHostAgentKindsAuthoritative(resolved.authoritative);
        }).catch(() => {
            if (!cancelled) {
                setHostAgentKinds(null);
                setHostAgentKindsAuthoritative(false);
            }
        });
        return () => { cancelled = true; };
    }, [socketStatus.status]);

    const availableAgents = React.useMemo(() => {
        const visible = new Set(hostAgentKinds ?? ['shell', agentType]);
        if (!hostAgentKindsAuthoritative) visible.add(agentType);
        return HOME_DOCK_AGENTS.filter((agent) => visible.has(agent.key));
    }, [agentType, hostAgentKinds, hostAgentKindsAuthoritative]);
    const currentAgent = availableAgents.find((agent) => agent.key === agentType)
        ?? availableAgents[0]
        ?? HOME_DOCK_AGENTS[0]!;
    const selectAgent = React.useCallback((agent: NewSessionAgentType) => setAgentType(agent), [setAgentType]);

    React.useEffect(() => {
        const firstAgent = availableAgents.find((agent) => agent.key !== 'shell');
        if (hostAgentKindsAuthoritative && firstAgent !== undefined && !availableAgents.some((agent) => agent.key === agentType)) {
            selectAgent(firstAgent.key as NewSessionAgentType);
        }
    }, [agentType, availableAgents, hostAgentKindsAuthoritative, selectAgent]);

    return {
        agentType,
        availableAgents,
        currentAgent,
        currentMachine,
        currentProject,
        currentWorktree,
        machineOptions,
        projectOptions,
        selectedMachineId,
        selectedWorktreeKey,
        selectAgent,
        setMachineId,
        setPath,
        setSessionType,
        setWorktreeKey,
        worktreeOptions,
    };
}
