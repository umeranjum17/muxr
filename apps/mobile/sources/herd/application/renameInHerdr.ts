import { HERDR_AGENT_NAME_MAX, HERDR_NAME_MAX, type HerdrRenameTarget, type HerdrTreePane } from '@muxr/contract';
import type { AlertButton } from '@/modal';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { agentLabels, isShellLabels } from '../domain/agentPresentation';

/** An agent's name is Herdr's handle: typed straight into its alphabet. */
export function agentHandle(text: string): string {
    return text.toLowerCase().replace(/\s/g, '-').replace(/[^a-z0-9_-]/g, '');
}

/**
 * Ask for a new name and set it in Herdr, where every client reads names from.
 * `id` is the Herdr id the tree carries: the pane's for an agent or a pane.
 * A refused rename says why and leaves the old name in place.
 */
export async function renameInHerdr(target: HerdrRenameTarget, id: string, current: string): Promise<void> {
    const agent = target === 'agent';
    const typed = await Modal.prompt(`Rename ${target}`, agent ? 'Lowercase letters, numbers, - and _.' : undefined, {
        defaultValue: agent ? agentHandle(current) : current,
        confirmText: 'Save',
        required: true,
        maxLength: agent ? HERDR_AGENT_NAME_MAX : HERDR_NAME_MAX,
        ...(agent ? { transform: agentHandle } : {}),
    });
    const name = typed?.trim() ?? '';
    if (name === '' || name === current) return;
    try {
        await sync.request('herdr.rename', { target, id, name });
    } catch (cause) {
        Modal.alert('Could not rename', cause instanceof Error ? cause.message : String(cause));
    }
    await sync.refreshHerdTree().catch(() => undefined);
}

/** A pane's name is its agent's, else (a shell) its own label. */
export function renamePane(pane: HerdrTreePane): Promise<void> {
    const labels = agentLabels(pane);
    return isShellLabels(labels)
        ? renameInHerdr('pane', pane.paneId, labels.title)
        : renameInHerdr('agent', pane.paneId, pane.agentName ?? '');
}

/**
 * What a long-press on a named item offers: Rename, and Close where the item
 * already closed on long-press, so that stays one more tap away.
 */
export function showNameActions(title: string, rename: () => void, close?: { label: string; onPress: () => void }): void {
    const buttons: AlertButton[] = [{ text: 'Rename', onPress: rename }];
    if (close !== undefined) buttons.push({ text: close.label, style: 'destructive', onPress: close.onPress });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Modal.alert(title, undefined, buttons);
}
