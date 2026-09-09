import type { PluginManifestV1, PluginSummary } from '@muxr/contract';
import type { SessionSource } from './sessionSource.js';

export type RunPluginActionCommand =
    | { action: 'list'; deviceId: string }
    | { action: 'manifest'; pluginId: string; manifestHash: string }
    | { action: 'approve'; deviceId: string; pluginId: string; manifestHash: string; approved: boolean }
    | { action: 'invoke'; deviceId: string; pluginId: string; manifestHash: string; contributionId: string; sessionId: string; idempotencyKey: string }
    | { action: 'call'; deviceId: string; pluginId: string; manifestHash: string; contributionId: string; input?: unknown; idempotencyKey?: string }
    | { action: 'stream'; deviceId: string; pluginId: string; manifestHash: string; contributionId: string; channel: string; sessionId?: string };

export type RunPluginActionResult =
    | { ok: true; data: PluginSummary[] | PluginManifestV1 | unknown | null }
    | { ok: false; error: string };

export async function runPluginAction(
    sessions: Pick<SessionSource, 'pluginList' | 'pluginManifest' | 'pluginApprove' | 'pluginInvoke' | 'pluginCall' | 'pluginStream'>,
    command: RunPluginActionCommand,
): Promise<RunPluginActionResult> {
    if (command.action === 'list') return { ok: true, data: await sessions.pluginList(command.deviceId) };
    if (command.action === 'manifest') {
        return { ok: true, data: await sessions.pluginManifest({ pluginId: command.pluginId, manifestHash: command.manifestHash }) };
    }
    if (command.action === 'approve') {
        const { action: _action, ...params } = command;
        await sessions.pluginApprove(params);
        return { ok: true, data: null };
    }
    if (command.action === 'invoke') {
        const { action: _action, ...params } = command;
        await sessions.pluginInvoke(params);
        return { ok: true, data: null };
    }
    if (command.action === 'stream') {
        const { action: _action, ...params } = command;
        return { ok: true, data: await sessions.pluginStream(params) };
    }
    const { action: _action, ...call } = command;
    return { ok: true, data: await sessions.pluginCall(call) };
}
