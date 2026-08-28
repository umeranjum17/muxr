import { randomUUID } from 'expo-crypto';
import type { Router } from 'expo-router';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, parsePluginAction, type PluginAction, type PluginManifestV1, type PluginSource, type RequestParams } from '@muxr/contract';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { downloadAttachment } from '@/utils/downloadAttachment';
import { navigateToSession } from '@/herd';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { capabilityFor } from './capabilityRegistry';
import { pluginHref } from '../domain/pluginHref';
import { sharedPluginWriteKeys } from '../domain/screenModel';
import { pluginSnapshot } from './pluginStore';
import { resolvePluginText } from '../domain/pluginText';
import { t } from '@/text';

export type PluginActionContext = {
    pluginId: string;
    manifestHash: string;
    manifest: PluginManifestV1;
    sessionId?: string;
    /** Secure prompts mint one key and never retain a secret-derived fingerprint. */
    oneTimeIdempotencyKey?: string;
};

export function sourceLabel(source: PluginSource): string {
    if (source.kind === 'github') return `GitHub · ${source.owner ?? 'unknown'}/${source.repo ?? 'unknown'}`;
    if (source.kind === 'npm') return `npm · ${source.name}@${source.version}`;
    return 'Local plugin';
}

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

export async function dispatchPluginAction(
    value: unknown,
    context: PluginActionContext & { router: Router; input?: unknown },
): Promise<unknown> {
    const action = validatePluginAction(value, context);
    if (action.type === 'screen') {
        context.router.push(pluginHref(context.pluginId, action.contributionId, action.params));
        return;
    }
    if (action.type === 'kernel.navigate') {
        if (action.target === 'session') {
            navigateToSession(context.router, action.sessionId);
        } else if (action.target === 'file') {
            context.router.push(`/session/${encodeURIComponent(context.sessionId!)}/file?path=${encodeURIComponent(action.path)}` as never);
        } else if (action.target === 'preview') {
            context.router.push(`/session/${encodeURIComponent(context.sessionId!)}/preview?port=${action.port}` as never);
        } else {
            context.router.push(`/web-view?url=${encodeURIComponent(action.url)}` as never);
        }
        return;
    }
    if (action.type === 'open-url') {
        const accepted = await Modal.confirm(t('plugins.openWebsite'), action.url, { confirmText: t('plugins.open') });
        if (accepted) await openExternalUrl(action.url);
        return;
    }
    if (action.type === 'attachment') {
        await downloadAttachment(context.sessionId!, {
            id: action.id,
            name: action.name,
            mimeType: action.mimeType ?? 'application/octet-stream',
            size: action.size,
            at: 0,
        });
        return;
    }
    if (action.type === 'capability') {
        return capabilityFor(action.name, context.manifest)!({ sessionId: context.sessionId ?? '', status: '', from: '' });
    }
    if (action.type === 'secure-prompt') {
        const attribution = securePromptAttribution(context);
        const value = await Modal.prompt(
            `Secure input · ${attribution.title}`,
            `${attribution.source}\n\n${resolvePluginText(action.title)}\n${resolvePluginText(action.message)}`,
            { placeholder: action.placeholder === undefined ? '' : resolvePluginText(action.placeholder), inputType: 'secure-text' },
        );
        const secret = value?.trim();
        if (!secret) return { cancelled: true as const };
        return dispatchPluginAction(action.submit, { ...context, input: { [action.inputKey]: secret }, oneTimeIdempotencyKey: randomUUID() });
    }
    if (action.type === 'confirm') {
        const accepted = await Modal.confirm(resolvePluginText(action.title), resolvePluginText(action.message), {
            confirmText: resolvePluginText(action.confirmLabel),
            ...(action.destructive === true ? { destructive: true } : {}),
        });
        if (!accepted) return { cancelled: true as const };
        return dispatchPluginAction(action.action, context);
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
    const result = await sync.request('plugin.call', params, PLUGIN_CALL_CLIENT_TIMEOUT_MS);
    if (idempotencyKey !== undefined && context.oneTimeIdempotencyKey === undefined) sharedPluginWriteKeys.clear(slot);
    return result;
}
