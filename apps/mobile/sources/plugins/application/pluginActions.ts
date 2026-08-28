import type { Router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { Modal } from '@/modal';
import { downloadAttachment } from '@/utils/downloadAttachment';
import { navigateToSession } from '@/herd';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { t } from '@/text';
import { capabilityFor } from './capabilityRegistry';
import {
    runPluginAction,
    type PluginActionContext,
    type RunPluginActionResult,
} from './RunPluginAction';

export { sourceLabel, validatePluginAction, type PluginActionContext } from './RunPluginAction';

/** Thin adapter: named use case decides, this layer talks to the person. */
export async function dispatchPluginAction(
    value: unknown,
    context: PluginActionContext & { router: Router; input?: unknown },
): Promise<unknown> {
    const result: RunPluginActionResult = await runPluginAction({ value, context });
    if (result.kind === 'rpc') return result.value;
    if (result.kind === 'cancelled') return { cancelled: true as const };
    if (result.kind === 'navigate') {
        context.router.push(result.href as never);
        return;
    }
    if (result.kind === 'focus-agent') {
        navigateToSession(context.router, result.agentRoute);
        return;
    }
    if (result.kind === 'open-url') {
        const accepted = await Modal.confirm(t('plugins.openWebsite'), result.url, { confirmText: t('plugins.open') });
        if (accepted) await openExternalUrl(result.url);
        return;
    }
    if (result.kind === 'attachment') {
        await downloadAttachment(result.sessionId, {
            id: result.id,
            name: result.name,
            mimeType: result.mimeType,
            size: result.size,
            at: 0,
        });
        return;
    }
    if (result.kind === 'capability') {
        return capabilityFor(result.name, context.manifest)!({ sessionId: result.sessionId, status: '', from: '' });
    }
    if (result.kind === 'secure-prompt') {
        const secret = (await Modal.prompt(result.heading, result.body, {
            placeholder: result.placeholder,
            inputType: 'secure-text',
        }))?.trim();
        if (!secret) return { cancelled: true as const };
        return dispatchPluginAction(result.next, {
            ...context,
            input: { [result.inputKey]: secret },
            oneTimeIdempotencyKey: randomUUID(),
        });
    }
    const accepted = await Modal.confirm(result.title, result.body, {
        confirmText: result.confirmLabel,
        ...(result.destructive ? { destructive: true } : {}),
    });
    if (!accepted) return { cancelled: true as const };
    return dispatchPluginAction(result.next, context);
}
