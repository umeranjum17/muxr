import { isSessionIdle, type MachineInfo, type SessionInfo, type SessionStatus } from '@muxr/contract';
import type { Machine, Session } from './storageTypes';
import { getCachedConnectionSettings } from '../state/connectionSettings';

function parseTime(value: string | undefined): number {
    if (value === undefined) return Date.now();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
}

/** What the Pi SDK reports as `firstMessage` for a journal with no user turn. */
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
    const machineId = getCachedConnectionSettings().machineId;
    // Herdr runs every CLI, so the agent kind is per session, not per build.
    const kind = info.agentKind ?? 'agent';
    const kindName = kind.charAt(0).toUpperCase() + kind.slice(1);
    // Live or recently-active: the phone shows whatever herdr currently lists.
    const active = busy || Date.now() - updatedAt < ACTIVE_SESSION_MS;
    return {
        id: info.id,
        seq: 0,
        createdAt,
        updatedAt,
        active,
        activeAt: updatedAt,
        ...(status?.agentStatus === 'blocked' ? { agentState: blockedAgentState(kindName) } : {}),
        metadata: {
            path: cwd,
            homeDir: cwd,
            host: machineId,
            machineId,
            flavor: 'pi',
            client: { id: 'herdr', name: kindName, version: 'muxr' },
            provider: { id: kind, kind, name: kindName },
            ...(status?.agentStatus === undefined
                ? {}
                : { agentStatus: status.agentStatus, lifecycleStateSince: updatedAt }),
            ...(info.agentKind === undefined || info.agentKind === '' ? {} : { agentKind: info.agentKind }),
            ...(info.paneId === undefined || info.paneId === '' ? {} : { paneId: info.paneId }),
            ...(info.terminalTitle === undefined || info.terminalTitle === '' ? {} : { terminalTitle: info.terminalTitle }),
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
            // `metadata.version` is read as a legacy CLI semver. muxr's host is not
            // that CLI, so leaving it unset keeps the "CLI Update Required" banner off.
            startedBy: 'daemon',
            ...(displayName === undefined ? {} : { summary: { text: displayName, updatedAt } }),
            rigMetadataVersion: 1,
            // The UI gates every optional feature on this. Declare what muxr
            // really supports: unset meant "no attachments, no abort button".
            // File RPCs stay off while sources/sync/ops.ts stubs them.
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
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: busy,
        thinkingAt: busy ? Date.now() : 0,
        presence: active ? 'online' : updatedAt,
        draft: null,
    };
}

/**
 * Undefined means "no title yet", not "use the folder name": falling back to the
 * cwd basename gave every session in a repo the same name, and each session.list
 * refresh overwrote a real title with it.
 */
export function sessionDisplayName(info: SessionInfo): string | undefined {
    if (info.name !== undefined && info.name.trim().length > 0) return info.name.trim();
    return undefined;
}

export function machineInfoToMachine(info: MachineInfo): Machine {
    const now = Date.now();
    return {
        id: info.machineId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: info.online,
        activeAt: parseTime(info.lastSeenAt),
        metadata: {
            host: '',
            platform: 'linux',
            happyCliVersion: info.hostVersion ?? 'muxr',
            happyHomeDir: '',
            homeDir: '',
            ...(info.name?.trim() ? { displayName: info.name.trim() } : {}),
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
                // herdr's lifecycle word drives the status dot / kanban grouping;
                // keep it current on every status.update.
                ...(status.agentStatus === undefined
                    ? {}
                    : {
                          agentStatus: status.agentStatus,
                          lifecycleStateSince: status.agentStatus === session.metadata.agentStatus
                              ? session.metadata.lifecycleStateSince ?? now
                              : now,
                      }),
            },
    };
}
