import { router } from 'expo-router';
import { storage } from '@/sync/storage';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { startSessionFromDraft } from '@/hooks/startSessionFromDraft';
import { isMachineOnline } from '@/utils/machineUtils';
import { Modal } from '@/modal';
import {
    beginRealtimeConversation,
    ensureRealtimeProviderConfigured,
    requestRealtimePermission,
    startRealtimeWithPermission,
} from '@/realtime/realtimeActions';
import {
    openRealtimeConversation,
    realtimeSessionSnapshot,
    resolveRealtimeTarget,
    registerRealtimeNotificationStart,
} from '@/realtime/realtimeSessionState';

let starting = false;

/** Reuse the exact configured machine/project/agent flow without owning Home. */
async function startConfiguredBlankSession(): Promise<string | null> {
    const machines = Object.values(storage.getState().machines);
    const selected = machines.find((machine) => machine.id === useNewSessionDraft.getState().selectedMachineId);
    if (!selected || !isMachineOnline(selected)) {
        router.navigate('/new-agent');
        return null;
    }
    return startSessionFromDraft({
        machines,
        blank: true,
        navigateToSession: (sessionId) => router.navigate(`/session/${encodeURIComponent(sessionId)}` as never),
    });
}

/**
 * App-level realtime capability. It works from a mounted control, a cold
 * shortcut, or the Android notification action and has no Home dependency.
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
