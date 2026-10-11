import type { UnreadCatalog } from '@trymuxr/contract';
import { createAttentionStore, type AttentionStore } from '../infrastructure/attentionStore.js';
import { createUnreadStore } from '../infrastructure/unreadStore.js';
import { createLifecycleStore, type LifecycleStore } from '../infrastructure/lifecycleStore.js';

export interface AgentWatchStores {
    unread: {
        catalog(): UnreadCatalog;
        acknowledge(sessionId: string, throughSeq?: number): UnreadCatalog;
        noteActivity(sessionId: string, cwd: string): UnreadCatalog;
    };
    attention: AttentionStore;
    lifecycle: LifecycleStore;
    /** Flush every store's pending write; resolves once they have all landed. */
    dispose(): Promise<void>;
}

export interface CreateAgentWatchStoresOptions {
    dataDir: string;
    now?: () => Date;
}

export function createAgentWatchStores(options: CreateAgentWatchStoresOptions): AgentWatchStores {
    const now = options.now ?? (() => new Date());
    const unread = createUnreadStore(options.dataDir, now);
    const attention = createAttentionStore(options.dataDir, now);
    const lifecycle = createLifecycleStore(options.dataDir, now);
    return {
        unread,
        attention,
        lifecycle,
        dispose: async (): Promise<void> => {
            await Promise.all([unread.dispose(), attention.dispose(), lifecycle.dispose()]);
        },
    };
}
