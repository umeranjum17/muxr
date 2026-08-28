import * as React from 'react';
import { useAsyncAction } from '@/hooks/useAsyncAction';
import { useNavigateToSession } from './useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, sessionSetAgentModes, forkAndSpawn, type ForkSource } from '@/sync/ops';
import { useLocalSetting, useMachine } from '@/sync/storage';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { t } from '@/text';
import { ActionError } from '@/utils/errors';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from './copySessionMetadataToClipboard';
import { useSessionStatus } from './sessionUtils';
import { isMachineOnline } from '@/pairing';
import { getSessionForkSource } from './sessionFork';
import { useRouter } from 'expo-router';
import { DuplicateSheet } from '@/spawn/ui';
import type { SessionActionShortcutId } from '@/keyboard/shortcuts';
import { isRigMetadata } from '@/sync/rig';
import { ResumeEligibility, type ResumeAvailability } from '../domain/ResumeEligibility';

export interface SessionActionItem {
    id: SessionActionShortcutId;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface UseSessionQuickActionsOptions {
    onAfterCopySessionMetadata?: () => void;
}

function getResumeAvailability(session: Session | undefined, machine: Machine | null | undefined, isConnected: boolean): ResumeAvailability {
    return ResumeEligibility.decide({
        exists: session !== undefined,
        isRig: session !== undefined && isRigMetadata(session.metadata),
        hostAllowsResume: session?.metadata?.capabilities?.resume === true,
        isConnected,
        machineId: session?.metadata?.machineId,
        machineKnown: machine != null,
        machineOnline: machine != null && isMachineOnline(machine),
        copy: {
            missingMachine: t('sessionInfo.resumeSessionMissingMachine'),
            sameMachineOnly: t('sessionInfo.resumeSessionSameMachineOnly'),
            machineOffline: t('sessionInfo.resumeSessionMachineOffline'),
            ready: t('sessionInfo.resumeSessionSubtitle'),
        },
    });
}

export function useSessionQuickActions(
    session: Session | undefined,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterCopySessionMetadata,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session?.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const resumeAvailability = React.useMemo(
        () => getResumeAvailability(session, machine, sessionStatus.isConnected),
        [machine, session, sessionStatus.isConnected],
    );

    // Fork eligibility — separate from resume because fork works on both
    // active AND inactive provider sessions. The user-facing toggle is the same
    // expResumeSession experiment so all three flows (resume / fork /
    // duplicate) ride a single switch on settings/features.
    const forkSource = React.useMemo(() => getSessionForkSource(session), [
        session?.id,
        session?.metadata?.machineId,
        session?.metadata?.path,
    ]);
    const canFork = Boolean(
        session
        && !isRigMetadata(session.metadata)
        && forkSource
        && machine
        && isMachineOnline(machine),
    );

    const openDetails = React.useCallback(() => {
        if (!session) return;
        router.push(`/session/${session.id}/info`);
    }, [router, session?.id]);

    const copySessionMetadata = React.useCallback(() => {
        if (!session) return;
        void (async () => {
            const copied = await copySessionMetadataToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const copySessionMetadataAndLogs = React.useCallback(() => {
        if (!session) return;
        void (async () => {
            const copied = await copySessionMetadataAndLogsToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const [resumingSession, performResume] = useAsyncAction(async () => {
        if (!session) return;

        if (!resumeAvailability.canResume) {
            throw new ActionError(resumeAvailability.message, false);
        }

        if (!machineId) {
            throw new ActionError(t('sessionInfo.resumeSessionMissingMachine'), false);
        }

        const modeMeta = resolveMessageModeMeta(session);
        const result = await machineResumeSession({
            machineId,
            sessionId: session.id,
            model: modeMeta.model ?? undefined,
            permissionMode: modeMeta.permissionMode,
        });

        switch (result.type) {
            case 'success': {
                // Session reconnects to the same ID, so messages are preserved.
                // Refresh to pick up the updated session state.
                await sync.refreshSessions();

                if (session.permissionMode) {
                    sessionSetAgentModes(result.sessionId, { permissionMode: session.permissionMode });
                }
                // Model / effort picks survive resume on their own — they live
                // in the session's synced metadata (#1492).

                navigateToSession(result.sessionId);
                return;
            }
            case 'requestToApproveDirectoryCreation':
                throw new ActionError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new ActionError(result.errorMessage, false);
        }
    });

    const resumeSession = React.useCallback(() => {
        performResume();
    }, [performResume]);

    // Fork the session (no truncation) — copies the on-disk Claude JSONL
    // and spawns a fresh session on the same machine. Works for
    // both active and inactive sessions; the source row stays untouched.
    const [forking, performFork] = useAsyncAction(async () => {
        if (!canFork) {
            throw new ActionError(t('session.forkErrorMissingMetadata'), false);
        }
        if (!forkSource) {
            throw new ActionError(t('session.forkErrorMissingMetadata'), false);
        }
        const result = await forkAndSpawn(forkSource as ForkSource);
        if (result.type !== 'success') {
            throw new ActionError(result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric'), false);
        }
        navigateToSession(result.sessionId);
    });

    const forkSession = React.useCallback(() => {
        performFork();
    }, [performFork]);

    const openDuplicateSheet = React.useCallback(() => {
        if (!session || !canFork) return;
        Modal.show({
            component: DuplicateSheet,
            props: { sessionId: session.id },
        } as any);
    }, [canFork, session?.id]);

    const canCopySessionMetadata = __DEV__ || devModeEnabled;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        const items: SessionActionItem[] = [
            { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
        ];

        if (resumeAvailability.canShowResume) {
            items.push({ id: 'resume', icon: 'play-circle-outline', label: t('sessionInfo.resumeSession'), onPress: resumeSession });
        }

        if (canFork) {
            items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
            items.push({ id: 'duplicate', icon: 'time-outline', label: t('session.duplicateAction'), onPress: openDuplicateSheet });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        return items;
    }, [
        canCopySessionMetadata,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSource,
        forkSession,
        openDetails,
        openDuplicateSheet,
        resumeAvailability.canShowResume,
        resumeSession,
    ]);

    const showActionAlert = React.useCallback(() => {
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = actionItems.map(item => ({
            text: item.label,
            onPress: item.onPress,
            style: item.destructive ? 'destructive' as const : undefined,
        }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert('Session', undefined, buttons);
    }, [actionItems]);

    return {
        actionItems,
        showActionAlert,
        canCopySessionMetadata,
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        canFork,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        forking,
        openDetails,
        openDuplicateSheet,
        resumeSession,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
    };
}
