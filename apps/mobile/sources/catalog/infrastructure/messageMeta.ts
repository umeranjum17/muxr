import type { Session } from '@/sync/storageTypes';
type PermissionModeKey = string;
import {
    getRigCurrentModel,
    getRigModels,
    getRigReasoningLevels,
    getRigReasoningSelection,
    getRigSelectedModelKey,
    isRigMetadataV1,
} from '@/sync/rig';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    modelProviderId?: string;
    effort?: string | null;
};

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
): MessageModeMeta {
    if (isRigMetadataV1(session.metadata)) {
        const meta: MessageModeMeta = {};
        const permissionMode = session.permissionMode
            ?? session.metadata?.currentOperatingModeCode
            ?? session.metadata?.permissionMode
            ?? session.metadata?.session?.permissionMode;
        if (permissionMode) meta.permissionMode = permissionMode;

        const selectedKey = session.modelMode ?? getRigSelectedModelKey(session.metadata);
        const models = getRigModels(session.metadata);
        const selectedFromList = models.find((model) => model.key === selectedKey);
        const selectedIsCurrent = selectedKey === getRigSelectedModelKey(session.metadata);
        const selectedModel = selectedFromList ?? (selectedIsCurrent ? getRigCurrentModel(session.metadata) : null);
        if (selectedModel) {
            meta.model = selectedModel.id;
            meta.modelProviderId = selectedModel.providerId;
        } else if (selectedKey?.includes(':')) {
            const separator = selectedKey.indexOf(':');
            meta.modelProviderId = selectedKey.slice(0, separator);
            meta.model = selectedKey.slice(separator + 1);
        }

        const levels = getRigReasoningLevels(session.metadata, selectedKey);
        const localEffort = session.effortLevel;
        const effort = localEffort && levels.includes(localEffort)
            ? localEffort
            : getRigReasoningSelection(session.metadata, selectedKey);
        if (effort) meta.effort = effort;
        return meta;
    }

    const meta: MessageModeMeta = {};

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        meta.permissionMode = session.permissionMode;
    }

    const modelMode = session.modelMode ?? undefined;
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;
    }

    const effort = session.effortLevel ?? undefined;
    if (effort !== undefined) {
        meta.effort = effort;
    }

    return meta;
}
