/**
 * Account-scoped Web Push and native Expo Push delivery. Fire-and-forget safe:
 * delivery failures never affect routing, and expired devices are pruned.
 */

import { join } from 'node:path';
import webpush from 'web-push';
import { readPrivateFile, writeJsonFileAtomic } from './persist.js';

export interface PushSubscriptionRecord {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    createdAt: string;
}

export interface PushPayload {
    title: string;
    body: string;
    sessionId: string;
    machineId: string;
}

interface ExpoPushTokenRecord {
    token: string;
    deviceId?: string;
    createdAt: string;
}

interface PushSubscriptionsFile {
    accounts: Record<string, PushSubscriptionRecord[]>;
    expoAccounts?: Record<string, ExpoPushTokenRecord[]>;
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
            this.subs = parsed.accounts;
            this.expoSubs = parsed.expoAccounts ?? {};
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

    /** Send every configured push channel for this account. Never throws. */
    async notify(accountId: string, payload: PushPayload): Promise<{ sent: number }> {
        const list = this.subs[accountId] ?? [];
        const body = JSON.stringify(payload);
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
                        title: 'muxr',
                        body: 'An agent needs your attention.',
                        sound: 'default',
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

        if (dead.length > 0 || this.expoSubs[accountId]?.length !== expo.length) await this.persist().catch(() => {});
        return { sent: results.filter((result) => result.status === 'fulfilled').length + expoSent };
    }

    private async removeExpo(accountId: string, matches: (entry: ExpoPushTokenRecord) => boolean): Promise<void> {
        const list = this.expoSubs[accountId] ?? [];
        const remaining = list.filter((entry) => !matches(entry));
        if (remaining.length === list.length) return;
        this.expoSubs[accountId] = remaining;
        await this.persist();
    }

    private persist(): Promise<void> {
        return writeJsonFileAtomic(this.subsPath, { accounts: this.subs, expoAccounts: this.expoSubs });
    }
}
