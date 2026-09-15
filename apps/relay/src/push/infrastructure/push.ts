/**
 * Account-scoped Web Push and native Expo Push delivery. Fire-and-forget safe:
 * delivery failures never affect routing, and expired devices are pruned.
 */

import { join } from 'node:path';
import { isIP } from 'node:net';
import {
    lifecycleNotificationAllowed,
    type LifecycleNotificationLevel,
    type LifecycleReasonCode,
} from '@muxr/contract';
import webpush from 'web-push';
import { readPrivateFile, writeJsonFileAtomic } from '../../platform/persist.js';

export interface PushSubscriptionRecord {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    /** Lifecycle level filter, parity with ExpoPushTokenRecord. */
    level?: LifecycleNotificationLevel;
    createdAt: string;
}

/** Delivery dedup entries older than this stop suppressing retries. */
const DELIVERED_EVENT_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Push endpoints must be deliverable Web Push destinations: a public https
 * push service with no embedded credentials, or plain http only to loopback
 * (local diagnostics stubs). Rejects non-http(s) schemes, userinfo, absurd
 * lengths, https hosts that resolve to loopback / private / link-local /
 * otherwise non-public addresses, and single-label or reserved internal
 * names — a subscription must never point the relay at an arbitrary
 * internal URL.
 */
export function isAllowedPushEndpoint(value: unknown): value is string {
    if (typeof value !== 'string' || value === '' || value.length > 2048) return false;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (/\s/.test(parsed.hostname) || parsed.hostname === '') return false;
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === 'http:') {
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    }
    return !isInternalHttpsHost(host);
}

const INTERNAL_SUFFIXES = [
    '.localhost', '.local', '.internal', '.lan', '.home', '.corp',
    '.intranet', '.private', '.test', '.example', '.invalid',
];

function isInternalHttpsHost(host: string): boolean {
    const name = host.endsWith('.') ? host.slice(0, -1) : host;
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    if (isIP(bare) !== 0) return !isPublicIpLiteral(bare);
    if (bare === 'localhost') return true;
    if (!bare.includes('.')) return true;
    for (const suffix of INTERNAL_SUFFIXES) {
        if (bare.endsWith(suffix)) return true;
    }
    return false;
}

function hexPairToDotted(pair: string): string | null {
    const groups = pair.split(':');
    if (groups.length !== 1 && groups.length !== 2) return null;
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
    const hex = groups.map((group) => group.padStart(4, '0')).join('').padStart(8, '0');
    if (!/^[0-9a-f]{8}$/.test(hex)) return null;
    const bytes = [0, 2, 4, 6].map((index) => parseInt(hex.slice(index, index + 2), 16));
    return bytes.join('.');
}

function mappedIpv4ToDotted(lower: string): string | null {
    if (lower.startsWith('::ffff:')) {
        const tail = lower.slice('::ffff:'.length);
        if (tail.includes('.')) return tail;
        return hexPairToDotted(tail);
    }
    const groups = lower.split(':');
    if (groups.length === 8
        && groups.slice(0, 5).every((group) => /^[0-9a-f]{1,4}$/.test(group) && parseInt(group, 16) === 0)
        && groups[5] === 'ffff') {
        const tail = `${groups[6]}:${groups[7]}`;
        if ((groups[7] ?? '').includes('.')) return groups[7] ?? null;
        return hexPairToDotted(tail);
    }
    return null;
}

function isPublicIpLiteral(value: string): boolean {
    if (isIP(value) === 4) {
        const parts = value.split('.').map(Number);
        const [a, b] = parts;
        if (a === undefined || b === undefined) return false;
        if (a === 10) return false;
        if (a === 127) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 192 && b === 0 && parts[2] === 2) return false;
        if (a === 198 && (b === 18 || b === 19)) return false;
        if (a === 198 && b === 51 && parts[2] === 100) return false;
        if (a === 203 && b === 0 && parts[2] === 113) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        if (a === 0 || a >= 224) return false;
        return true;
    }
    const lower = value.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    const mappedDotted = mappedIpv4ToDotted(lower);
    if (mappedDotted !== null) return isPublicIpLiteral(mappedDotted);
    if (lower.includes('.')) return isPublicIpLiteral(lower.slice(lower.lastIndexOf(':') + 1));
    const first = lower.split(':')[0] ?? '';
    if (/^fe[89ab]/.test(first)) return false;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
    if (lower.startsWith('ff')) return false;
    return true;
}

export interface PushPayload {
    eventId: string;
    kind: PushNotificationKind;
    reasonCode: LifecycleReasonCode;
    agentName: string;
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
    agentName?: unknown;
    taskTitle?: unknown;
}): Pick<PushPayload, 'eventId' | 'kind' | 'reasonCode' | 'agentName' | 'taskTitle'> | undefined {
    if (typeof value.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.eventId)) return undefined;
    if (value.kind !== 'blocked' && value.kind !== 'done' && value.kind !== 'failed') return undefined;
    if (typeof value.reasonCode !== 'string' || !REASON_CODES.has(value.reasonCode as LifecycleReasonCode)) return undefined;
    const reasonCode = value.reasonCode as LifecycleReasonCode;
    if (typeof value.agentName !== 'string') return undefined;
    const agentName = value.agentName;
    if (agentName.length === 0 || agentName.length > 80 || /[\0-\x1F\x7F]/.test(agentName)) return undefined;
    if (value.taskTitle === undefined) return { eventId: value.eventId, kind: value.kind, reasonCode, agentName };
    if (typeof value.taskTitle !== 'string') return undefined;
    const taskTitle = value.taskTitle;
    if (taskTitle === '' || taskTitle.length > 120 || /[\0-\x1F\x7F]/.test(taskTitle)) return undefined;
    const privacyProbe = taskTitle.normalize('NFKC').trimStart();
    if (/^(?:\/|[A-Za-z]:\\)|\b(?:token|password|secret|credential)\s*=/i.test(privacyProbe)) return undefined;
    return { eventId: value.eventId, kind: value.kind, reasonCode, agentName, taskTitle };
}

interface ExpoPushTokenRecord {
    token: string;
    deviceId?: string;
    level?: LifecycleNotificationLevel;
    createdAt: string;
}

interface PushSubscriptionsFile {
    accounts: Record<string, PushSubscriptionRecord[]>;
    expoAccounts?: Record<string, ExpoPushTokenRecord[]>;
    deliveredEvents?: Array<{ accountId: string; eventId: string; at?: string }>;
}

const DELIVERED_EVENT_LIMIT = 2_048;

function boundDeliveredEvents(events: Array<{ accountId: string; eventId: string; at?: string }>, now = Date.now()): Array<{ accountId: string; eventId: string; at?: string }> {
    const counts = new Map<string, number>();
    return events.filter((entry) => typeof entry?.accountId === 'string' && typeof entry.eventId === 'string'
        && (typeof entry.at !== 'string' || now - Date.parse(entry.at) < DELIVERED_EVENT_TTL_MS))
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
    private deliveredEvents: Array<{ accountId: string; eventId: string; at?: string }> = [];
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

    async subscribe(
        accountId: string,
        subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
        opts: { level?: LifecycleNotificationLevel } = {},
    ): Promise<void> {
        if (!isAllowedPushEndpoint(subscription.endpoint)) throw new Error('push subscription endpoint is not an allowed Web Push destination');
        const list = (this.subs[accountId] ?? []).filter((entry) => entry.endpoint !== subscription.endpoint);
        list.push({
            ...subscription,
            ...(opts.level === undefined ? {} : { level: opts.level }),
            createdAt: new Date().toISOString(),
        });
        this.subs[accountId] = list;
        await this.persist();
    }

    async subscribeExpo(
        accountId: string,
        token: string,
        level: LifecycleNotificationLevel = 'important',
        deviceId?: string,
    ): Promise<void> {
        const list = (this.expoSubs[accountId] ?? []).filter((entry) => entry.token !== token && (deviceId === undefined || entry.deviceId !== deviceId));
        list.push({ token, level, ...(deviceId === undefined ? {} : { deviceId }), createdAt: new Date().toISOString() });
        this.expoSubs[accountId] = list;
        await this.persist();
    }

    async removeExpoDevice(accountId: string, deviceId: string): Promise<void> {
        await this.removeExpo(accountId, (entry) => entry.deviceId === deviceId);
    }

    /** Drop a single web-push subscription by endpoint (logout, revoke, re-pair). */
    async removeWebSubscription(accountId: string, endpoint: string): Promise<void> {
        const list = this.subs[accountId] ?? [];
        const remaining = list.filter((entry) => entry.endpoint !== endpoint);
        if (remaining.length === list.length) return;
        this.subs[accountId] = remaining;
        await this.persist();
    }

    async removeExpoToken(accountId: string, token: string): Promise<void> {
        await this.removeExpo(accountId, (entry) => entry.token === token);
    }

    /** Send every configured push channel for this account, coalescing concurrent retries. */
    async notify(accountId: string, payload: PushPayload): Promise<{ sent: number; duplicate?: true }> {
        const key = `${accountId}\0${payload.eventId}`;
        this.deliveredEvents = boundDeliveredEvents(this.deliveredEvents);
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
        const bodyText = `${payload.agentName}${suffix}`;
        const list = this.subs[accountId] ?? [];
        // Level-filtered like Expo subs: a device that asked for important-only
        // never wakes for done noise.
        const eligible = list.filter((entry) =>
            lifecycleNotificationAllowed(entry.level ?? 'important', payload.kind));
        const body = JSON.stringify({ ...payload, title, body: bodyText, presentationOwner: 'relay-push' });
        const results = await Promise.allSettled(eligible.map((sub) => webpush.sendNotification(sub, body, { TTL: 24 * 60 * 60, urgency: payload.kind === 'blocked' ? 'high' : 'normal' })));
        const dead = eligible.filter((sub, index) => results[index]?.status === 'rejected' && isGone((results[index] as PromiseRejectedResult).reason));
        if (dead.length > 0) {
            const gone = new Set(dead);
            this.subs[accountId] = list.filter((sub) => !gone.has(sub));
        }

        const expo = this.expoSubs[accountId] ?? [];
        const eligibleExpo = expo.filter((entry) =>
            lifecycleNotificationAllowed(entry.level ?? 'important', payload.kind));
        let expoSent = 0;
        if (eligibleExpo.length > 0) {
            try {
                const response = await fetch('https://exp.host/--/api/v2/push/send', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(eligibleExpo.map(({ token }) => ({
                        to: token,
                        title,
                        body: bodyText,
                        sound: 'default',
                        collapseId: payload.eventId,
                        data: {
                            eventId: payload.eventId,
                            kind: payload.kind,
                            reasonCode: payload.reasonCode,
                            agentName: payload.agentName,
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
                    const deadTokens = new Set(eligibleExpo
                        .filter((_, index) => tickets[index]?.details?.error === 'DeviceNotRegistered')
                        .map((entry) => entry.token));
                    this.expoSubs[accountId] = expo.filter((entry) => !deadTokens.has(entry.token));
                }
            } catch {}
        }

        const sent = results.filter((result) => result.status === 'fulfilled').length + expoSent;
        if (sent > 0) {
            // Mark after provider acceptance so total send failures remain retryable.
            // A crash before this queued write can still duplicate; transports offer no atomic send+commit.
            this.deliveredEvents.push({ accountId, eventId: payload.eventId, at: new Date().toISOString() });
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
