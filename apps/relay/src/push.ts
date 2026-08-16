/**
 * Web Push service. Web-first: browser phones (and later iOS PWAs) subscribe
 * via the Push API; the relay sends VAPID-authenticated Web Push to their
 * endpoints. Fire-and-forget safe: send failures never affect routing, and
 * expired subscriptions (404/410) are pruned.
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

interface PushSubscriptionsFile {
    accounts: Record<string, PushSubscriptionRecord[]>;
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
        }
    }

    publicKey(): string {
        if (this.vapid === undefined) throw new Error('push: vapid not loaded');
        return this.vapid.publicKey;
    }

    async subscribe(accountId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
        const list = this.subs[accountId] ?? [];
        list.push({ ...subscription, createdAt: new Date().toISOString() });
        this.subs[accountId] = list;
        await writeJsonFileAtomic(this.subsPath, { accounts: this.subs });
    }

    /** Send a Web Push to every subscription of the account. Never throws. */
    async notify(accountId: string, payload: PushPayload): Promise<{ sent: number }> {
        const list = this.subs[accountId] ?? [];
        if (list.length === 0) return { sent: 0 };
        const body = JSON.stringify(payload);
        const results = await Promise.allSettled(list.map((sub) => webpush.sendNotification(sub, body)));
        const dead: PushSubscriptionRecord[] = [];
        results.forEach((result, index) => {
            if (result.status === 'rejected' && isGone(result.reason)) {
                const sub = list[index];
                if (sub !== undefined) dead.push(sub);
            }
        });
        if (dead.length > 0) {
            const gone = new Set(dead);
            this.subs[accountId] = list.filter((sub) => !gone.has(sub));
            await writeJsonFileAtomic(this.subsPath, { accounts: this.subs }).catch(() => {});
        }
        return { sent: results.filter((result) => result.status === 'fulfilled').length };
    }
}
