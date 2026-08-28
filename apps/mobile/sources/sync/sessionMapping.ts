import { isSessionIdle, type MachineInfo, type SessionInfo, type SessionStatus } from '@muxr/contract';
import type { Machine, Session } from './storageTypes';
import { getCachedConnectionSettings } from '../state/connectionSettings';

function parseTime(value: string | undefined): number {
    if (value === undefined) return Date.now();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * How long a quiet session keeps counting as active. Pi sessions never report
 * going offline, so a hardcoded `active: true` piled every session muxr had
 * ever seen into the Terminals active group and none of them ever left.
 */
export const ACTIVE_SESSION_MS = 30 * 60 * 1000;

/**
 * A blocked herdr agent has an approval UI on screen. The row state for that is
 * already `permission_required`, which is driven by `agentState.requests` -- so
 * publish one synthetic request rather than inventing a second vocabulary. The
 * answer is keys in the terminal, not an allow/deny RPC.
 */
function blockedAgentState(agentName: string): Session['agentState'] {
    return {
        usageLimits: { capturedAt: Date.now(), windows: [] },
        requests: { herdr: { tool: `${agentName} is waiting for you`, arguments: {}, createdAt: Date.now() } },
    };
}

export function sessionInfoToSession(info: SessionInfo, status?: SessionStatus): Session {
    const createdAt = parseTime(info.created);
    const updatedAt = parseTime(info.modified);
    const busy = status !== undefined && !isSessionIdle(status);
    const cwd = info.cwd;
    const displayName = sessionDisplayName(info);
    const taskTitle = info.taskTitle?.trim() || 'Current task';
    const machineId = getCachedConnectionSettings().machineId;
    const kind = info.agentKind ?? 'agent';
    const kindName = kind.charAt(0).toUpperCase() + kind.slice(1);
    const active = busy || Date.now() - updatedAt < ACTIVE_SESSION_MS;
    const blocked = status?.agentStatus === 'blocked';
    return {
        id: info.id,
        seq: 0,
        createdAt,
        updatedAt,
        active,
        activeAt: updatedAt,
        ...(blocked ? { agentState: blockedAgentState(displayName ?? kindName) } : {}),
        metadata: sessionMetadataFromInfo(info, {
            cwd,
            displayName,
            taskTitle,
            machineId,
            kind,
            kindName,
            status,
            updatedAt,
        }),
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: busy,
        thinkingAt: busy ? Date.now() : 0,
        presence: active ? 'online' : updatedAt,
        draft: null,
    };
}

function sessionMetadataFromInfo(
    info: SessionInfo,
    fields: {
        cwd: string;
        displayName: string | undefined;
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
        ...(fields.displayName === undefined ? {} : { displayName: fields.displayName }),
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

/**
 * Undefined means "no title yet", not "use the folder name": falling back to the
 * cwd basename gave every session in a repo the same name, and each session.list
 * refresh overwrote a real title with it.
 */
export function sessionDisplayName(info: SessionInfo): string | undefined {
    if (info.displayName !== undefined && info.displayName.trim().length > 0) return info.displayName.trim();
    if (info.name !== undefined && info.name.trim().length > 0) return info.name.trim();
    return undefined;
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
    // Busy covers descendants: a parent with live subagents is not idle. `active`
    // is deliberately not touched -- it means connected, and it decides whether a
    // session shows in the list or hides behind the inactive toggle.
    const busy = !isSessionIdle(status);
    // A herdr agent showing an approval UI is the same row state as a Pi
    // permission request: the session needs the user before it moves.
    const blocked = status.agentStatus === 'blocked';
    return {
        ...session,
        thinking: busy,
        thinkingAt: busy ? now : session.thinkingAt,
        agentState: blocked ? blockedAgentState(session.metadata?.provider?.name ?? 'Agent') : null,
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
                          lifecycleStateSince: unchangedLifecycleSince(session.metadata, status.agentStatus, now),
                      }),
            },
    };
}

function unchangedLifecycleSince(
    metadata: NonNullable<Session['metadata']>,
    nextStatus: SessionStatus['agentStatus'],
    now: number,
): number {
    const statusUnchanged = nextStatus === metadata.agentStatus;
    if (statusUnchanged && metadata.lifecycleStateSince !== undefined) return metadata.lifecycleStateSince;
    return now;
}
