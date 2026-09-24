import { router } from 'expo-router';
import { storage } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { startSessionFromDraft } from '@/hooks/startSessionFromDraft';
import { Modal } from '@/modal';
import {
    beginRealtimeConversation,
    ensureRealtimeProviderConfigured,
    requestRealtimePermission,
    startRealtimeWithPermission,
} from './realtimeActions';
import {
    openRealtimeConversation,
    realtimeSessionSnapshot,
    resolveRealtimeTarget,
    registerRealtimeNotificationStart,
} from './realtimeSessionState';

let starting = false;

/** Reuse the exact configured machine/project/agent flow without owning Home. */
async function startConfiguredBlankSession(): Promise<string | null> {
    const machines = Object.values(storage.getState().machines);
    const selected = machines.find((machine) => machine.id === useNewSessionDraft.getState().selectedMachineId);
    // Machine liveness is the catalog's `active` flag; pairing's
    // isMachineOnline is the same check but importing it here would make
    // conversation and pairing depend on each other.
    if (!selected || !selected.active) {
        router.navigate('/new-agent');
        return null;
    }
    return startSessionFromDraft({
        machines,
        blank: true,
        // herd's FocusAgent rule, inlined because herd already depends on
        // conversation: one agent screen over Home, so back is Home.
        navigateToSession: (sessionId) => {
            const href = `/session/${encodeURIComponent(sessionId)}` as const;
            if (router.canDismiss()) router.dismissTo(href);
            else router.push(href);
        },
    });
}

/**
 * App-level adapter for FocusAgent then StartRealtimeConversation.
 * It works from a mounted control, a cold shortcut, or the Android
 * notification action and has no Home dependency.
 */
export async function startRealtimeCapability(input: { sessionId?: string } = {}): Promise<void> {
    if (realtimeSessionSnapshot().state !== 'disconnected') {
        openRealtimeConversation();
        return;
    }
    if (starting) return;
    starting = true;
    try {
        const explicit = input.sessionId?.trim();
        const target = explicit
            ? { machineId: getCachedConnectionSettings().machineId, sessionId: explicit }
            : await resolveRealtimeTarget();
        if (target !== null && target.sessionId !== '') {
            await startRealtimeWithPermission(target);
            return;
        }
        if (!(await requestRealtimePermission())) return;
        if (!(await ensureRealtimeProviderConfigured())) return;
        const sessionId = await startConfiguredBlankSession();
        if (sessionId !== null) beginRealtimeConversation({
            machineId: getCachedConnectionSettings().machineId,
            sessionId,
        });
    } catch (error) {
        Modal.alert('Realtime conversation', error instanceof Error ? error.message : String(error));
    } finally {
        starting = false;
    }
}

registerRealtimeNotificationStart(() => startRealtimeCapability());
