import type { StoredHostedGrant } from '../application/linkPairing';
import { grantRejectsDowngrade } from '../domain/hostedGrant';
import { secretDelete, secretGet, secretSet, grantSecretNames } from './hostedSecretStore';

const grantKey = (machineId: string): string => `muxr.grant.${machineId}`;
const GRANTS_INDEX = 'muxr.grants.index';
let cache: Record<string, StoredHostedGrant> | undefined;

export async function loadGrants(): Promise<Record<string, StoredHostedGrant>> {
    if (cache !== undefined) return cache;
    let ids: string[] = [];
    const indexRaw = await secretGet(GRANTS_INDEX);
    if (indexRaw !== null) {
        try {
            const parsed = JSON.parse(indexRaw) as unknown;
            if (Array.isArray(parsed)) ids = parsed.filter((entry): entry is string => typeof entry === 'string');
        } catch { ids = []; }
    }
    ids = [...new Set([...ids, ...await grantSecretNames()])];
    if (ids.length > 0) {
        const entries = await Promise.all(ids.map(async (id) => {
            try {
                const raw = await secretGet(grantKey(id));
                return raw === null ? undefined : [id, JSON.parse(raw) as StoredHostedGrant] as const;
            } catch { return undefined; }
        }));
        const live = entries.filter((entry) => entry !== undefined);
        await secretSet(GRANTS_INDEX, JSON.stringify(live.map(([id]) => id)));
        cache = Object.fromEntries(live);
        return cache;
    }
    cache = {};
    return cache;
}

export function cachedGrant(machineId: string): StoredHostedGrant | undefined {
    return cache?.[machineId];
}

export async function deleteGrant(machineId: string): Promise<StoredHostedGrant[]> {
    const all = await loadGrants();
    if (all[machineId] === undefined) return Object.values(all);
    delete all[machineId];
    await Promise.all([
        secretDelete(grantKey(machineId)),
        secretSet(GRANTS_INDEX, JSON.stringify(Object.keys(all))),
    ]);
    return Object.values(all);
}

export async function storeGrant(grant: StoredHostedGrant): Promise<void> {
    const all = await loadGrants();
    const existing = all[grant.machineId];
    if (existing !== undefined && existing.credential === '' && grantRejectsDowngrade(existing.keyVersion, grant.keyVersion)) throw new Error('pairing grant downgrade rejected');
    all[grant.machineId] = grant;
    await secretSet(grantKey(grant.machineId), JSON.stringify(grant));
    await secretSet(GRANTS_INDEX, JSON.stringify(Object.keys(all)));
}

export async function clearGrants(): Promise<void> {
    const all = await loadGrants();
    await Promise.all([
        secretDelete(GRANTS_INDEX),
        ...Object.keys(all).map((id) => secretDelete(grantKey(id))),
    ]);
    cache = undefined;
}
