import type { UnreadCatalog } from '@muxr/contract';
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
}

export interface CreateAgentWatchStoresOptions {
    dataDir: string;
    now?: () => Date;
}

export function createAgentWatchStores(options: CreateAgentWatchStoresOptions): AgentWatchStores {
    const now = options.now ?? (() => new Date());
    return {
        unread: createUnreadStore(options.dataDir, now),
        attention: createAttentionStore(options.dataDir, now),
        lifecycle: createLifecycleStore(options.dataDir, now),
    };
}
