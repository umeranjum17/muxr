import { Platform } from 'react-native';
import { HERDR_AGENT_NAME_MAX, HERDR_NAME_MAX, type HerdrRenameTarget, type HerdrTreePane } from '@muxr/contract';
import type { AlertButton } from '@/modal';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { agentHandle, agentLabels, isShellLabels, renamedTo } from '../domain/agentPresentation';

/**
 * Ask for a new name and set it in Herdr, where every client reads names from.
 * `id` is the Herdr id the tree carries: the pane's for an agent or a pane.
 * A refused rename says why and leaves the old name in place.
 */
export async function renameInHerdr(target: HerdrRenameTarget, id: string, current: string): Promise<void> {
    const agent = target === 'agent';
    const typed = await Modal.prompt(`Rename ${target}`, agent ? 'Use a–z, 0–9, - and _.' : undefined, {
        defaultValue: agent ? agentHandle(current) : current,
        confirmText: 'Save',
        required: true,
        maxLength: agent ? HERDR_AGENT_NAME_MAX : HERDR_NAME_MAX,
        ...(agent ? { transform: agentHandle } : {}),
    });
    const name = renamedTo(typed, current);
    if (name === null) return;
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
 * already closed on long-press, so that stays one more tap away. `kind` says
 * what the item is under its name.
 */
export function showNameActions(title: string, kind: string, rename: () => void, close?: { label: string; onPress: () => void }): void {
    const actions: AlertButton[] = [{ text: 'Rename', onPress: rename }];
    if (close !== undefined) actions.push({ text: close.label, style: 'destructive', onPress: close.onPress });
    const cancel: AlertButton = { text: 'Cancel', style: 'cancel' };
    // Android lays buttons out left to right and keeps the last for the main action.
    Modal.alert(title, kind, Platform.OS === 'android' ? [cancel, ...actions.reverse()] : [...actions, cancel]);
}

/** A pane's long-press: its agent or shell, renamed, or closed when `close` is given. */
export function showPaneActions(pane: HerdrTreePane, close?: () => void): void {
    const labels = agentLabels(pane);
    showNameActions(labels.title, isShellLabels(labels) ? 'Shell' : 'Agent', () => void renamePane(pane),
        close === undefined ? undefined : { label: 'Close pane', onPress: close });
}

/** A tab's long-press. */
export function showTabActions(tabId: string, label: string): void {
    showNameActions(label, 'Tab', () => void renameInHerdr('tab', tabId, label));
}
