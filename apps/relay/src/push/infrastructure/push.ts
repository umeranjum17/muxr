/**
 * Account-scoped Web Push and native Expo Push delivery. Fire-and-forget safe:
 * delivery failures never affect routing, and expired devices are pruned.
 */

import { join } from 'node:path';
import type { LifecycleReasonCode } from '@muxr/contract';
import webpush from 'web-push';
import { readPrivateFile, writeJsonFileAtomic } from '../../platform/persist.js';

export interface PushSubscriptionRecord {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    createdAt: string;
}

export interface PushPayload {
    eventId: string;
    kind: PushNotificationKind;
    reasonCode: LifecycleReasonCode;
    displayName: string;
    taskTitle?: string;
    sessionId: string;
    machineId: string;
}

export type PushNotificationKind = 'blocked' | 'done' | 'failed';

const COPY_SUFFIX: Record<PushNotificationKind, string> = {
    blocked: ' needs attention.',
    done: ' finished.',
    failed: ' failed.',
};

const REASON_CODES = new Set<LifecycleReasonCode>([
    'start-requested', 'start-launch-failed', 'start-timeout', 'squad-rolled-back',
    'agent-working', 'agent-blocked', 'agent-done', 'agent-runtime-failed',
    'agent-unavailable', 'state-reconciled',
]);

const START_FAILURE_REASONS = new Set<LifecycleReasonCode>([
    'start-launch-failed', 'start-timeout', 'squad-rolled-back', 'agent-unavailable',
]);

/** Validate the host's fixed lifecycle fields before constructing push copy. */
export function parsePushNotification(value: {
    eventId?: unknown;
    kind?: unknown;
    reasonCode?: unknown;
    displayName?: unknown;
    taskTitle?: unknown;
}): Pick<PushPayload, 'eventId' | 'kind' | 'reasonCode' | 'displayName' | 'taskTitle'> | undefined {
    if (typeof value.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.eventId)) return undefined;
    if (value.kind !== 'blocked' && value.kind !== 'done' && value.kind !== 'failed') return undefined;
    if (typeof value.reasonCode !== 'string' || !REASON_CODES.has(value.reasonCode as LifecycleReasonCode)) return undefined;
    const reasonCode = value.reasonCode as LifecycleReasonCode;
    if (typeof value.displayName !== 'string') return undefined;
    const displayName = value.displayName.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (displayName.length > 80 || !/^[\p{L}\p{M}][\p{L}\p{M}' -]*(?: [2-9][0-9]*)?$/u.test(displayName)) return undefined;
    if (value.taskTitle === undefined) return { eventId: value.eventId, kind: value.kind, reasonCode, displayName };
    if (typeof value.taskTitle !== 'string') return undefined;
    const taskTitle = value.taskTitle.normalize('NFKC').replace(/[\0-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (taskTitle === '' || taskTitle.length > 120 || /^(?:\/|[A-Za-z]:\\)|\b(?:token|password|secret|credential)\s*=/i.test(taskTitle)) return undefined;
    return { eventId: value.eventId, kind: value.kind, reasonCode, displayName, taskTitle };
}

interface ExpoPushTokenRecord {
    token: string;
    deviceId?: string;
    createdAt: string;
}

interface PushSubscriptionsFile {
    accounts: Record<string, PushSubscriptionRecord[]>;
    expoAccounts?: Record<string, ExpoPushTokenRecord[]>;
    deliveredEvents?: Array<{ accountId: string; eventId: string }>;
}

const DELIVERED_EVENT_LIMIT = 2_048;

function boundDeliveredEvents(events: Array<{ accountId: string; eventId: string }>): Array<{ accountId: string; eventId: string }> {
    const counts = new Map<string, number>();
    return events.filter((entry) => typeof entry?.accountId === 'string' && typeof entry.eventId === 'string')
        .reverse()
        .filter((entry) => {
            const count = counts.get(entry.accountId) ?? 0;
            counts.set(entry.accountId, count + 1);
            return count < DELIVERED_EVENT_LIMIT;
        })
        .reverse();
}

function isGone(error: unknown): boolean {
    const status = (error as { statusCode?: unknown })?.statusCode;
    return status === 404 || status === 410;
}

export class PushService {
    private readonly vapidPath: string;
    private readonly subsPath: string;
    private vapid: { publicKey: string; privateKey: string } | undefined;
    private subs: Record<string, PushSubscriptionRecord[]> = {};
    private expoSubs: Record<string, ExpoPushTokenRecord[]> = {};
    private deliveredEvents: Array<{ accountId: string; eventId: string }> = [];
    private readonly deliveries = new Map<string, Promise<{ sent: number; duplicate?: true }>>();
    private readonly undurableEvents = new Set<string>();
    private persistChain: Promise<void> = Promise.resolve();

    constructor(dataDir: string) {
        this.vapidPath = join(dataDir, 'vapid.json');
        this.subsPath = join(dataDir, 'push-subscriptions.json');
    }

    async load(): Promise<void> {
        const vapidRaw = await readPrivateFile(this.vapidPath);
        if (vapidRaw !== undefined) {
            const parsed = JSON.parse(vapidRaw) as { publicKey?: unknown; privateKey?: unknown };
            if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
                this.vapid = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
            }
        }
        if (this.vapid === undefined) {
            // Generated once into the data dir; persists across restarts so
            // existing subscriptions keep validating.
            this.vapid = webpush.generateVAPIDKeys();
            await writeJsonFileAtomic(this.vapidPath, this.vapid);
        }
        webpush.setVapidDetails('mailto:herd@muxr.local', this.vapid.publicKey, this.vapid.privateKey);
        const subscriptionsRaw = await readPrivateFile(this.subsPath);
        if (subscriptionsRaw !== undefined) {
            const parsed = JSON.parse(subscriptionsRaw) as PushSubscriptionsFile;
            this.subs = parsed.accounts ?? {};
            this.expoSubs = parsed.expoAccounts ?? {};
            this.deliveredEvents = boundDeliveredEvents(parsed.deliveredEvents ?? []);
        }
    }

    publicKey(): string {
        if (this.vapid === undefined) throw new Error('push: vapid not loaded');
        return this.vapid.publicKey;
    }

    async subscribe(accountId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
        const list = (this.subs[accountId] ?? []).filter((entry) => entry.endpoint !== subscription.endpoint);
        list.push({ ...subscription, createdAt: new Date().toISOString() });
        this.subs[accountId] = list;
        await this.persist();
    }

    async subscribeExpo(accountId: string, token: string, deviceId?: string): Promise<void> {
        const list = (this.expoSubs[accountId] ?? []).filter((entry) => entry.token !== token && (deviceId === undefined || entry.deviceId !== deviceId));
        list.push({ token, ...(deviceId === undefined ? {} : { deviceId }), createdAt: new Date().toISOString() });
        this.expoSubs[accountId] = list;
        await this.persist();
    }

    async removeExpoDevice(accountId: string, deviceId: string): Promise<void> {
        await this.removeExpo(accountId, (entry) => entry.deviceId === deviceId);
    }

    async removeExpoToken(accountId: string, token: string): Promise<void> {
        await this.removeExpo(accountId, (entry) => entry.token === token);
    }

    /** Send every configured push channel for this account, coalescing concurrent retries. */
    async notify(accountId: string, payload: PushPayload): Promise<{ sent: number; duplicate?: true }> {
        const key = `${accountId}\0${payload.eventId}`;
        if (this.deliveredEvents.some((entry) => entry.accountId === accountId && entry.eventId === payload.eventId)) {
            if (this.undurableEvents.has(key)) {
                await this.persist();
                this.undurableEvents.delete(key);
            }
            return { sent: 0, duplicate: true };
        }
        const active = this.deliveries.get(key);
        if (active !== undefined) return active;
        const delivery = this.deliver(accountId, payload).finally(() => this.deliveries.delete(key));
        this.deliveries.set(key, delivery);
        return delivery;
    }

    private async deliver(accountId: string, payload: PushPayload): Promise<{ sent: number }> {
        const title = payload.taskTitle ?? 'Agent update';
        const suffix = payload.kind === 'failed' && START_FAILURE_REASONS.has(payload.reasonCode)
            ? ' could not start.'
            : COPY_SUFFIX[payload.kind];
        const bodyText = `${payload.displayName}${suffix}`;
        const list = this.subs[accountId] ?? [];
        const body = JSON.stringify({ ...payload, title, body: bodyText, presentationOwner: 'relay-push' });
        const results = await Promise.allSettled(list.map((sub) => webpush.sendNotification(sub, body)));
        const dead = list.filter((sub, index) => results[index]?.status === 'rejected' && isGone((results[index] as PromiseRejectedResult).reason));
        if (dead.length > 0) {
            const gone = new Set(dead);
            this.subs[accountId] = list.filter((sub) => !gone.has(sub));
        }

        const expo = this.expoSubs[accountId] ?? [];
        let expoSent = 0;
        if (expo.length > 0) {
            try {
                const response = await fetch('https://exp.host/--/api/v2/push/send', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(expo.map(({ token }) => ({
                        to: token,
                        title,
                        body: bodyText,
                        sound: 'default',
                        collapseId: payload.eventId,
                        data: {
                            eventId: payload.eventId,
                            kind: payload.kind,
                            reasonCode: payload.reasonCode,
                            displayName: payload.displayName,
                            ...(payload.taskTitle === undefined ? {} : { taskTitle: payload.taskTitle }),
                            sessionId: payload.sessionId,
                            machineId: payload.machineId,
                            presentationOwner: 'relay-push',
                        },
                    }))),
                    signal: AbortSignal.timeout(5_000),
                });
                if (response.ok) {
                    const receipt = await response.json() as { data?: Array<{ status?: string; details?: { error?: string } }> };
                    const tickets = receipt.data ?? [];
                    expoSent = tickets.filter((entry) => entry.status === 'ok').length;
                    this.expoSubs[accountId] = expo.filter((_, index) => tickets[index]?.details?.error !== 'DeviceNotRegistered');
                }
            } catch {}
        }

        const sent = results.filter((result) => result.status === 'fulfilled').length + expoSent;
        if (sent > 0) {
            // Mark after provider acceptance so total send failures remain retryable.
            // A crash before this queued write can still duplicate; transports offer no atomic send+commit.
            this.deliveredEvents.push({ accountId, eventId: payload.eventId });
            this.deliveredEvents = boundDeliveredEvents(this.deliveredEvents);
            this.undurableEvents.add(`${accountId}\0${payload.eventId}`);
        }
        if (sent > 0 || dead.length > 0 || this.expoSubs[accountId]?.length !== expo.length) await this.persist();
        if (sent > 0) this.undurableEvents.delete(`${accountId}\0${payload.eventId}`);
        return { sent };
    }

    private async removeExpo(accountId: string, matches: (entry: ExpoPushTokenRecord) => boolean): Promise<void> {
        const list = this.expoSubs[accountId] ?? [];
        const remaining = list.filter((entry) => !matches(entry));
        if (remaining.length === list.length) return;
        this.expoSubs[accountId] = remaining;
        await this.persist();
    }

    private persist(): Promise<void> {
        const snapshot = structuredClone({
            accounts: this.subs,
            expoAccounts: this.expoSubs,
            deliveredEvents: this.deliveredEvents,
        });
        const write = this.persistChain.then(() => writeJsonFileAtomic(this.subsPath, snapshot));
        this.persistChain = write.catch(() => {});
        return write;
    }
}
