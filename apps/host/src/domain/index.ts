import type { UnreadCatalog } from '@muxr/contract';
import { createAttentionStore, type AttentionStore } from './attentionStore.js';
import { createUnreadStore } from './unreadStore.js';
import { createLifecycleStore, type LifecycleStore } from './lifecycleStore.js';

export interface DomainStores {
    unread: {
        catalog(): UnreadCatalog;
        acknowledge(sessionId: string, throughSeq?: number): UnreadCatalog;
        noteActivity(sessionId: string, cwd: string): UnreadCatalog;
    };
    attention: AttentionStore;
    lifecycle: LifecycleStore;
}

export interface CreateDomainStoresOptions {
    dataDir: string;
    now?: () => Date;
}

export function createDomainStores(options: CreateDomainStoresOptions): DomainStores {
    const now = options.now ?? (() => new Date());
    return {
        unread: createUnreadStore(options.dataDir, now),
        attention: createAttentionStore(options.dataDir, now),
        lifecycle: createLifecycleStore(options.dataDir, now),
    };
}
