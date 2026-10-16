import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/catalog/store';
import type { DraftAttachment } from '@/catalog';
import { useIsFocused } from '@react-navigation/native';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
    // The composer's chips, kept with the text so leaving the screen never
    // brings the text back without them. Restored once on mount.
    attachments?: readonly DraftAttachment[];
    onRestoreAttachments?: (attachments: readonly DraftAttachment[]) => void;
}

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000, attachments, onRestoreAttachments } = options;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Seed with the initial value so a pre-hydrated draft (e.g. ChatComposer
    // reads storage synchronously on mount) doesn't trip the autosave into
    // re-writing what we just loaded.
    const lastSavedValue = useRef<string>(value);
    const isFocused = useIsFocused();

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!sessionId) return;
        
        storage.getState().updateSessionDraft(sessionId, draft);
        lastSavedValue.current = draft;
    }, [sessionId]);

    // Load draft on mount and when focused
    useEffect(() => {
        if (!sessionId || !isFocused) return;

        const session = storage.getState().sessions[sessionId];
        if (session?.draft && !value) {
            onChange(session.draft);
            lastSavedValue.current = session.draft;
        } else if (!session?.draft) {
            // Ensure lastSavedValue is empty if there's no draft
            lastSavedValue.current = '';
        }
    }, [sessionId, isFocused, onChange]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!sessionId) return;

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        // Only save if value has changed
        if (value !== lastSavedValue.current) {
            const wasEmpty = !lastSavedValue.current.trim();
            const isEmpty = !value.trim();

            if (wasEmpty !== isEmpty) {
                // State transition: empty <-> non-empty
                // Save immediately for instant feedback
                saveDraft(value);
            } else if (!isEmpty) {
                // Text is being modified (non-empty to non-empty)
                // Debounce to avoid excessive saves
                saveTimeoutRef.current = setTimeout(() => {
                    saveDraft(value);
                }, autoSaveInterval);
            }
            // If both are empty, no need to save
        }

        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [value, sessionId, autoSaveInterval, saveDraft]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!sessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                if (value !== lastSavedValue.current) {
                    saveDraft(value);
                }
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [sessionId, value, saveDraft]);

    // Save on unmount only. Keyed on `value`, this cleanup ran on every
    // keystroke and wrote the store from a passive effect each time; on a slow
    // phone that chained into React's "Maximum update depth exceeded".
    const valueRef = useRef(value);
    useEffect(() => {
        valueRef.current = value;
    }, [value]);
    useEffect(() => {
        return () => {
            if (sessionId && valueRef.current !== lastSavedValue.current) {
                saveDraft(valueRef.current);
            }
        };
    }, [sessionId, saveDraft]);

    // Chips change rarely, so each change is written at once. Restoring takes
    // the stored ones out first, so the empty composer of the mount cannot
    // erase them and a repeated mount effect cannot restore them twice; the
    // next change writes them back.
    const restoreAttachments = useRef(onRestoreAttachments);
    restoreAttachments.current = onRestoreAttachments;
    useEffect(() => {
        if (!sessionId || !restoreAttachments.current) return;
        const stored = storage.getState().sessions[sessionId]?.draftAttachments;
        if (!stored?.length) return;
        storage.getState().updateSession(sessionId, { draftAttachments: null });
        restoreAttachments.current(stored);
    }, [sessionId]);
    useEffect(() => {
        if (!sessionId || attachments === undefined) return;
        const next = attachments.length > 0 ? attachments : null;
        if ((storage.getState().sessions[sessionId]?.draftAttachments ?? null) === next) return;
        storage.getState().updateSession(sessionId, { draftAttachments: next });
    }, [sessionId, attachments]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!sessionId) return;
        
        storage.getState().updateSessionDraft(sessionId, null);
        storage.getState().updateSession(sessionId, { draftAttachments: null });
        lastSavedValue.current = '';
    }, [sessionId]);

    return {
        clearDraft
    };
}