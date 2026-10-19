import { openNotice } from '@byokit/seal';
import { decodeBase64 } from '../encryption/base64';

export type LifecycleNotice = { title: string; body: string; data: Record<string, unknown> };

const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function isSealedLifecyclePush(payload: unknown): boolean {
    return typeof record(record(payload)?.data)?.sealed === 'string';
}

/** A tap may open the notice link only over https, or http to loopback/tailnet. */
export function isOpenableNotifyUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host) || host.endsWith('.ts.net');
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
            if (typeof fields.sessionId !== 'string' || fields.sessionId.length === 0 || fields.sessionId.length > 200) {
                // General notifications carry no session; lifecycle ones must.
                if (fields?.kind !== 'notify') continue;
            }
            if (!['blocked', 'done', 'failed', 'notify'].includes(String(fields.kind))) continue;
            if (fields.kind === 'notify' && fields.url !== undefined
                && (typeof fields.url !== 'string' || fields.url.length > 2048)) continue;
            return { title: opened.title, body: opened.body, data: fields };
        } catch {
            continue;
        }
    }
    return fallback;
}
