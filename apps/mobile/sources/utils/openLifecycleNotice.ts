import { openNotice } from '@byokit/seal';
import { decodeBase64 } from '../encryption/base64';

export type LifecycleNotice = { title: string; body: string; data: Record<string, unknown> };

const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function isSealedLifecyclePush(payload: unknown): boolean {
    return typeof record(record(payload)?.data)?.sealed === 'string';
}

export function openLifecycleNotice(payload: unknown, grants: Iterable<{ machineId: string; deviceKey: { secretKey: string } }>): LifecycleNotice {
    const fallback: LifecycleNotice = { title: 'Agent update', body: 'An agent has an update.', data: {} };
    const envelope = record(payload);
    const sealed = record(envelope?.data);
    if (sealed?.v !== 1 || typeof sealed.sealed !== 'string' || sealed.sealed.length > 2048) return fallback;
    for (const grant of grants) {
        try {
            const opened = record(openNotice(sealed, decodeBase64(grant.deviceKey.secretKey)));
            const fields = record(opened?.data);
            if (typeof opened?.title !== 'string' || opened.title.length > 120 || typeof opened.body !== 'string' || opened.body.length > 400) continue;
            if (fields?.machineId !== grant.machineId || fields.presentationOwner !== 'relay-push') continue;
            if (typeof fields.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(fields.eventId)) continue;
            if (typeof fields.sessionId !== 'string' || fields.sessionId.length === 0 || fields.sessionId.length > 200) continue;
            if (!['blocked', 'done', 'failed'].includes(String(fields.kind))) continue;
            return { title: opened.title, body: opened.body, data: fields };
        } catch {
            continue;
        }
    }
    return fallback;
}
