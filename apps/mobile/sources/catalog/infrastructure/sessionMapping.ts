import type { MachineInfo, SessionInfo, SessionStatus } from '@muxr/contract';
import type { Machine, Session } from './storageTypes';
import { getCachedConnectionSettings } from '@/connection';
import {
    AGENT_STILL_LISTED_MS,
    agentIsBusy,
    agentNeedsApproval,
    agentStillListed,
    approvalAgentState,
    agentNameFromHost,
    lifecycleSinceForAgent,
    providerKindFromHost,
    taskTitleFromHost,
} from '@/catalog/domain/agent';

export const ACTIVE_SESSION_MS = AGENT_STILL_LISTED_MS;

function parseTime(value: string | undefined, fallback = Date.now()): number {
    if (value === undefined) return fallback;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}


/** Map a host SessionInfo DTO once into the stored Agent snapshot. */
export function sessionInfoToSession(info: SessionInfo, status?: SessionStatus): Session {
    const createdAt = parseTime(info.created);
    const updatedAt = parseTime(info.modified, createdAt);
    const now = Date.now();
    const busy = agentIsBusy(status);
    const cwd = info.cwd;
    const agentName = agentNameFromHost(info);
    const taskTitle = taskTitleFromHost(info.taskTitle);
    const machineId = getCachedConnectionSettings().machineId;
    const provider = providerKindFromHost(info.agentKind);
    const listed = agentStillListed(busy, updatedAt, now);
    const blocked = agentNeedsApproval(status);
    const spokenName = agentName ?? provider.name;
    return {
        id: info.id,
        seq: 0,
        createdAt,
        updatedAt,
        active: listed,
        activeAt: updatedAt,
        metadata: sessionMetadataFromInfo(info, {
            cwd,
            agentName,
            taskTitle,
            machineId,
            kind: provider.kind,
            kindName: provider.name,
            status,
            updatedAt,
        }),
        metadataVersion: 1,
        agentState: blocked ? approvalAgentState(spokenName) : null,
        agentStateVersion: 0,
        thinking: busy,
        thinkingAt: busy ? now : 0,
        presence: listed ? 'online' : updatedAt,
        draft: null,
    };
}

function sessionMetadataFromInfo(
    info: SessionInfo,
    fields: {
        cwd: string;
        agentName: string | undefined;
        taskTitle: string;
        machineId: string;
        kind: string;
        kindName: string;
        status: SessionStatus | undefined;
        updatedAt: number;
    },
): Session['metadata'] {
    return {
        path: fields.cwd,
        homeDir: fields.cwd,
        host: fields.machineId,
        machineId: fields.machineId,
        flavor: 'pi',
        client: { id: 'herdr', name: fields.kindName, version: 'muxr' },
        provider: { id: fields.kind, kind: fields.kind, name: fields.kindName },
        ...(fields.status?.agentStatus === undefined
            ? {}
            : { agentStatus: fields.status.agentStatus, lifecycleStateSince: fields.updatedAt }),
        ...(info.agentKind === undefined || info.agentKind === '' ? {} : { agentKind: info.agentKind }),
        ...(info.paneId === undefined || info.paneId === '' ? {} : { paneId: info.paneId }),
        ...(info.terminalTitle === undefined || info.terminalTitle === '' ? {} : { terminalTitle: info.terminalTitle }),
        ...(fields.agentName === undefined ? {} : { agentName: fields.agentName }),
        taskTitle: fields.taskTitle,
        ...(info.worktree === undefined
            ? {}
            : {
                  worktree: {
                      repo: info.worktree.repo,
                      ...(info.worktree.branch === undefined ? {} : { branch: info.worktree.branch }),
                      path: info.worktree.path,
                  },
              }),
        ...(info.workspaceLabel === undefined || info.workspaceLabel === '' ? {} : { workspaceLabel: info.workspaceLabel }),
        ...(info.workspaceId === undefined || info.workspaceId === '' ? {} : { workspaceId: info.workspaceId }),
        ...(info.tabId === undefined || info.tabId === '' ? {} : { tabId: info.tabId }),
        ...(info.tabLabel === undefined || info.tabLabel === '' ? {} : { tabLabel: info.tabLabel }),
        ...(info.spawnedBy === undefined || info.spawnedBy === '' ? {} : { spawnedBy: info.spawnedBy }),
        startedBy: 'daemon',
        summary: { text: fields.taskTitle, updatedAt: fields.updatedAt },
        rigMetadataVersion: 1,
        capabilities: {
            abort: true,
            shell: true,
            steering: true,
            attachments: { enabled: true, maxBytes: 1_000_000, mediaTypes: ['image/*'] },
            files: { browse: false, read: false, search: false, write: false },
            modelSelection: true,
            reasoningSelection: true,
            permissionModeSelection: false,
            resume: false,
            rpcMethods: ['abort', 'bash'],
        },
        models: [],
        thoughtLevels: [],
    };
}

export function machineInfoToMachine(info: MachineInfo, pairedName?: string): Machine {
    const now = Date.now();
    const displayName = info.name?.trim() || pairedName?.trim();
    return {
        id: info.machineId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: info.online,
        activeAt: parseTime(info.lastSeenAt),
        metadata: {
            host: '',
            platform: info.platform ?? '',
            muxrCliVersion: info.hostVersion ?? 'muxr',
            muxrHomeDir: '',
            homeDir: '',
            ...(displayName ? { displayName } : {}),
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

export function applyStatusToSession(session: Session, status: SessionStatus): Session {
    const now = Date.now();
    const busy = agentIsBusy(status);
    const blocked = agentNeedsApproval(status);
    return {
        ...session,
        thinking: busy,
        thinkingAt: busy ? now : session.thinkingAt,
        agentState: blocked ? approvalAgentState(session.metadata?.provider?.name ?? 'Agent') : null,
        activeAt: now,
        latestUsage: status.contextUsage?.tokens != null
            ? {
                inputTokens: status.tokens.input,
                outputTokens: status.tokens.output,
                cacheCreation: status.tokens.cacheWrite,
                cacheRead: status.tokens.cacheRead,
                contextSize: status.contextUsage.tokens ?? 0,
                contextWindow: status.contextUsage.contextWindow,
                timestamp: Date.now(),
            }
            : session.latestUsage ?? null,
        metadata: session.metadata === null
            ? session.metadata
            : {
                ...session.metadata,
                ...(status.agentStatus === undefined
                    ? {}
                    : {
                          agentStatus: status.agentStatus,
                          lifecycleStateSince: lifecycleSinceForAgent(session.metadata, status.agentStatus, now),
                      }),
            },
    };
}
