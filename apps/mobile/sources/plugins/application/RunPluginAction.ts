import { randomUUID } from 'expo-crypto';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, parsePluginAction, type PluginAction, type PluginManifestV1, type PluginSource, type RequestParams } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { capabilityFor } from './capabilityRegistry';
import { pluginHref } from '../domain/pluginHref';
import { sharedPluginWriteKeys } from '../domain/screenModel';
import { pluginSnapshot } from './pluginStore';
import { resolvePluginText } from '../domain/pluginText';

export function sourceLabel(source: PluginSource): string {
    if (source.kind === 'github') return `GitHub · ${source.owner ?? 'unknown'}/${source.repo ?? 'unknown'}`;
    if (source.kind === 'npm') return `npm · ${source.name}@${source.version}`;
    return 'Local plugin';
}

export type RunPluginActionCommand = {
    value: unknown;
    context: {
        pluginId: string;
        manifestHash: string;
        manifest: PluginManifestV1;
        sessionId?: string;
        oneTimeIdempotencyKey?: string;
        input?: unknown;
    };
};

export type RunPluginActionResult =
    | { kind: 'rpc'; value: unknown }
    | { kind: 'cancelled' }
    | { kind: 'navigate'; href: string }
    | { kind: 'focus-agent'; agentRoute: string }
    | { kind: 'open-url'; url: string }
    | { kind: 'confirm'; title: string; body: string; confirmLabel: string; destructive: boolean; next: unknown }
    | { kind: 'secure-prompt'; heading: string; body: string; placeholder: string; inputKey: string; next: unknown }
    | { kind: 'attachment'; sessionId: string; id: string; name: string; mimeType: string; size: number }
    | { kind: 'capability'; name: string; sessionId: string };

export type PluginActionContext = RunPluginActionCommand['context'];

function securePromptAttribution(context: PluginActionContext): { title: string; source: string } {
    const entry = pluginSnapshot().find((candidate) =>
        candidate.summary.pluginId === context.pluginId && candidate.summary.manifestHash === context.manifestHash);
    return entry === undefined
        ? { title: 'Enabled plugin', source: 'Plugin source unavailable' }
        : { title: entry.summary.name, source: sourceLabel(entry.summary.source) };
}

/** Structural, reference, capability, and current-surface validation. */
export function validatePluginAction(value: unknown, context: PluginActionContext): PluginAction {
    const action = parsePluginAction(value);
    if (action.type === 'screen' && !context.manifest.contributions.some((candidate) =>
        'type' in candidate && candidate.type === 'screen' && candidate.id === action.contributionId)) {
        throw new Error(`Plugin action targets an unavailable screen: ${action.contributionId}`);
    }
    const call = action.type === 'plugin.call' ? action
        : action.type === 'secure-prompt' ? action.submit
        : action.type === 'confirm' ? action.action
        : undefined;
    if (call !== undefined) {
        const rpc = context.manifest.contributions.find((candidate) => candidate.slot === 'host.rpc' && candidate.id === call.contributionId);
        if (rpc === undefined || rpc.slot !== 'host.rpc') throw new Error(`Plugin action targets an unavailable RPC: ${call.contributionId}`);
        if ((action.type === 'secure-prompt' || action.type === 'confirm') && rpc.mode !== 'write') {
            throw new Error(`Plugin ${action.type} requires a write RPC`);
        }
    }
    if ((action.type === 'attachment' || action.type === 'kernel.navigate' && (action.target === 'file' || action.target === 'preview'))
        && context.sessionId === undefined) {
        const kind = action.type === 'attachment' ? 'attachment' : action.target;
        throw new Error(`Plugin action ${kind} needs session context`);
    }
    if (action.type === 'capability' && capabilityFor(action.name, context.manifest) === undefined) {
        throw new Error(`Plugin action capability is unavailable: ${action.name}`);
    }
    return action;
}

/** Run one declared plugin action. UI confirmation and navigation stay in the adapter. */
export async function runPluginAction(command: RunPluginActionCommand): Promise<RunPluginActionResult> {
    const { context } = command;
    const action = validatePluginAction(command.value, context);
    if (action.type === 'screen') {
        return { kind: 'navigate', href: pluginHref(context.pluginId, action.contributionId, action.params) };
    }
    if (action.type === 'kernel.navigate') {
        if (action.target === 'session') return { kind: 'focus-agent', agentRoute: action.sessionId };
        if (action.target === 'file') {
            return { kind: 'navigate', href: `/session/${encodeURIComponent(context.sessionId!)}/file?path=${encodeURIComponent(action.path)}` };
        }
        if (action.target === 'preview') {
            return { kind: 'navigate', href: `/session/${encodeURIComponent(context.sessionId!)}/preview?port=${action.port}` };
        }
        return { kind: 'navigate', href: `/web-view?url=${encodeURIComponent(action.url)}` };
    }
    if (action.type === 'open-url') return { kind: 'open-url', url: action.url };
    if (action.type === 'attachment') {
        return {
            kind: 'attachment',
            sessionId: context.sessionId!,
            id: action.id,
            name: action.name,
            mimeType: action.mimeType ?? 'application/octet-stream',
            size: action.size,
        };
    }
    if (action.type === 'capability') {
        return { kind: 'capability', name: action.name, sessionId: context.sessionId ?? '' };
    }
    if (action.type === 'secure-prompt') {
        const attribution = securePromptAttribution(context);
        return {
            kind: 'secure-prompt',
            heading: `Secure input · ${attribution.title}`,
            body: `${attribution.source}\n\n${resolvePluginText(action.title)}\n${resolvePluginText(action.message)}`,
            placeholder: action.placeholder === undefined ? '' : resolvePluginText(action.placeholder),
            inputKey: action.inputKey,
            next: action.submit,
        };
    }
    if (action.type === 'confirm') {
        return {
            kind: 'confirm',
            title: resolvePluginText(action.title),
            body: resolvePluginText(action.message),
            confirmLabel: resolvePluginText(action.confirmLabel),
            destructive: action.destructive === true,
            next: action.action,
        };
    }
    const rpc = context.manifest.contributions.find((candidate) =>
        candidate.slot === 'host.rpc' && candidate.id === action.contributionId);
    if (rpc === undefined || rpc.slot !== 'host.rpc') throw new Error('Plugin RPC unavailable');
    const input = context.input === undefined ? action.input : context.input;
    const slot = `${context.pluginId}:${context.manifestHash}:${action.contributionId}`;
    const idempotencyKey = rpc.mode === 'write'
        ? context.oneTimeIdempotencyKey ?? sharedPluginWriteKeys.keyFor(slot, input, randomUUID)
        : undefined;
    const params: RequestParams<'plugin.call'> = {
        pluginId: context.pluginId,
        manifestHash: context.manifestHash,
        contributionId: action.contributionId,
        ...(input === undefined ? {} : { input }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
    const value = await sync.request('plugin.call', params, PLUGIN_CALL_CLIENT_TIMEOUT_MS);
    if (idempotencyKey !== undefined && context.oneTimeIdempotencyKey === undefined) sharedPluginWriteKeys.clear(slot);
    return { kind: 'rpc', value };
}
