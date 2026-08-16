import { setTimeout as delay } from 'node:timers/promises';

export interface PushWebhookMetadata {
    machineId: string;
    sessionId?: string;
    at: number;
}

export interface PushWebhookConfig {
    url: string;
    maxRetries: number;
    timeoutMs: number;
}

/** Fire-and-forget push hook. Must never block or crash routing. */
export function enqueuePushWebhook(config: PushWebhookConfig, metadata: PushWebhookMetadata): void {
    void deliverPushWebhook(config, metadata).catch(() => {
        /* swallow: routing must not depend on webhook success */
    });
}

async function deliverPushWebhook(config: PushWebhookConfig, metadata: PushWebhookMetadata): Promise<void> {
    const body = JSON.stringify({
        machineId: metadata.machineId,
        ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
        at: metadata.at,
    });

    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
            const response = await fetch(config.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                signal: controller.signal,
            });
            if (response.ok) return;
        } catch {
            /* retry below */
        } finally {
            clearTimeout(timer);
        }
        if (attempt < config.maxRetries) {
            await delay(Math.min(250 * 2 ** attempt, 2000));
        }
    }
}
