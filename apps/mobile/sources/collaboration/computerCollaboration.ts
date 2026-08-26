import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import {
    DEFAULT_PEER_CAPABILITIES,
    type PeerCapability,
    type PeerMutationMetadata,
    type PeerRelationship,
    type PeerRequestMap,
    type PeerRequestType,
    type SignedPeerDescriptor,
} from '@muxr/contract';

const STORAGE_KEY = 'muxr.computer-collaboration.v1';
const MUTATION_TTL_MS = 5 * 60_000;

export const COLLABORATION_CAPABILITIES: PeerCapability[] = [...DEFAULT_PEER_CAPABILITIES];
export type CollaborationMachineState = 'Connected' | 'Setting up' | 'Waiting for computer' | 'Repair needed' | 'Disconnecting';

export interface CollaborationMachine {
    machineId: string;
    name: string;
    platform?: string;
    machineSigningPublicKey: string;
}

interface SetupProgress {
    prepareMutation?: PeerMutationMetadata;
    sourceName?: string;
    sourcePlatform?: string;
    descriptor?: SignedPeerDescriptor;
    authorizeMutation?: PeerMutationMetadata;
    sealedBundle?: string;
    peerDeviceId?: string;
    installMutation?: PeerMutationMetadata;
    repairNeeded?: boolean;
}

interface DisconnectProgress {
    targetMutation?: PeerMutationMetadata;
    targetRevoked?: boolean;
    sourceMutation?: PeerMutationMetadata;
    peerDeviceId?: string;
    repair?: true;
}

export interface CollaborationEdge {
    sourceMachineId: string;
    targetMachineId: string;
    relationshipId: string;
    setup?: SetupProgress;
    disconnect?: DisconnectProgress;
}

export interface CollaborationIntent {
    version: 1;
    selectedMachineIds: string[];
    machines: CollaborationMachine[];
    edges: CollaborationEdge[];
}

export interface CollaborationReport {
    intent: CollaborationIntent;
    states: Record<string, CollaborationMachineState>;
    reachableMachineIds: string[];
    errors: Record<string, string>;
}

export class PeerHostResponseError extends Error {
    constructor(message: string, readonly code?: string) {
        super(message);
        this.name = 'PeerHostResponseError';
    }
}

export type PeerRequester = <T extends PeerRequestType>(
    machineId: string,
    type: T,
    params: PeerRequestMap[T]['params'],
) => Promise<PeerRequestMap[T]['result']>;

const emptyIntent = (): CollaborationIntent => ({ version: 1, selectedMachineIds: [], machines: [], edges: [] });
const edgeKey = (source: string, target: string): string => `${source}\0${target}`;
const isActive = (relationship: PeerRelationship | undefined): boolean => relationship?.state === 'connected';
const isGone = (relationship: PeerRelationship | undefined): boolean => relationship === undefined || relationship.state === 'revoked';
const cloneIntent = (intent: CollaborationIntent): CollaborationIntent => JSON.parse(JSON.stringify(intent)) as CollaborationIntent;
const safeName = (value: string | undefined): string => value?.trim().slice(0, 120) || 'Paired computer';

function safeError(cause: unknown): string {
    if (!(cause instanceof PeerHostResponseError)) return 'Could not finish while a computer was unavailable. Retry when it is reachable.';
    switch (cause.code) {
        case 'peer-limit': return 'This computer has reached its collaboration limit.';
        case 'peer-already-authorized': return 'This connection needs repair before setup can continue.';
        case 'peer-operation-uncertain': return 'The computer is still checking an earlier request. Retry shortly.';
        default: return 'The computer rejected this setup step. Retry, or repair the connection if it continues.';
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizedMutation(value: unknown): PeerMutationMetadata | undefined {
    const candidate = record(value);
    return candidate !== undefined && typeof candidate.operationId === 'string' && candidate.operationId !== '' && candidate.operationId.length <= 160
        && Number.isFinite(candidate.notValidAfter)
        ? { operationId: candidate.operationId, notValidAfter: Number(candidate.notValidAfter) }
        : undefined;
}

function normalizedSetup(value: unknown): SetupProgress | undefined {
    if (value === undefined) return undefined;
    const source = record(value);
    if (source === undefined) return { repairNeeded: true };
    const setup: SetupProgress = {};
    let malformed = false;
    for (const field of ['prepareMutation', 'authorizeMutation', 'installMutation'] as const) {
        if (source[field] === undefined) continue;
        const mutation = normalizedMutation(source[field]);
        if (mutation === undefined) malformed = true; else setup[field] = mutation;
    }
    if (source.sourceName !== undefined) typeof source.sourceName === 'string' ? setup.sourceName = safeName(source.sourceName) : malformed = true;
    if (source.sourcePlatform !== undefined) typeof source.sourcePlatform === 'string' ? setup.sourcePlatform = source.sourcePlatform.slice(0, 80) : malformed = true;
    if (source.sealedBundle !== undefined) typeof source.sealedBundle === 'string' && source.sealedBundle.length <= 512 * 1024 ? setup.sealedBundle = source.sealedBundle : malformed = true;
    if (source.peerDeviceId !== undefined) typeof source.peerDeviceId === 'string' && source.peerDeviceId !== '' && source.peerDeviceId.length <= 200 ? setup.peerDeviceId = source.peerDeviceId : malformed = true;
    if (source.repairNeeded !== undefined) typeof source.repairNeeded === 'boolean' ? setup.repairNeeded = source.repairNeeded : malformed = true;
    if (source.descriptor !== undefined) {
        const descriptor = record(source.descriptor);
        const claims = record(descriptor?.claims);
        if (descriptor?.v === 1 && claims?.v === 1 && typeof descriptor.signature === 'string'
            && ['sourceMachineId', 'sourceMachineSigningPublicKey', 'targetMachineId', 'targetMachineSigningPublicKey', 'peerPublicKey', 'nonce']
                .every((field) => typeof claims[field] === 'string')
            && Number.isFinite(claims.preparedAt) && Number.isFinite(claims.expiresAt)) {
            setup.descriptor = source.descriptor as SignedPeerDescriptor;
        } else malformed = true;
    }
    if (malformed) setup.repairNeeded = true;
    return setup;
}

function normalizedDisconnect(value: unknown): DisconnectProgress | undefined {
    if (value === undefined) return undefined;
    const source = record(value);
    if (source === undefined) return { repair: true };
    const disconnect: DisconnectProgress = {};
    let malformed = false;
    for (const field of ['targetMutation', 'sourceMutation'] as const) {
        if (source[field] === undefined) continue;
        const mutation = normalizedMutation(source[field]);
        if (mutation === undefined) malformed = true; else disconnect[field] = mutation;
    }
    if (source.targetRevoked !== undefined) typeof source.targetRevoked === 'boolean' ? disconnect.targetRevoked = source.targetRevoked : malformed = true;
    if (source.peerDeviceId !== undefined) typeof source.peerDeviceId === 'string' && source.peerDeviceId !== '' && source.peerDeviceId.length <= 200 ? disconnect.peerDeviceId = source.peerDeviceId : malformed = true;
    if (source.repair !== undefined) source.repair === true ? disconnect.repair = true : malformed = true;
    if (malformed) disconnect.repair = true;
    return disconnect;
}

function normalizeIntent(value: unknown): CollaborationIntent | undefined {
    const source = record(value);
    if (source?.version !== 1 || !Array.isArray(source.selectedMachineIds) || !Array.isArray(source.machines) || !Array.isArray(source.edges)) return undefined;
    const machines = new Map<string, CollaborationMachine>();
    for (const value of source.machines.slice(0, 32)) {
        const machine = record(value);
        if (typeof machine?.machineId !== 'string' || machine.machineId === '' || typeof machine.name !== 'string'
            || typeof machine.machineSigningPublicKey !== 'string' || machine.machineSigningPublicKey === '') continue;
        machines.set(machine.machineId, {
            machineId: machine.machineId,
            name: safeName(machine.name),
            machineSigningPublicKey: machine.machineSigningPublicKey,
            ...(typeof machine.platform === 'string' ? { platform: machine.platform.slice(0, 80) } : {}),
        });
    }
    const edges = new Map<string, CollaborationEdge>();
    for (const value of source.edges.slice(0, 256)) {
        const edge = record(value);
        if (typeof edge?.sourceMachineId !== 'string' || edge.sourceMachineId === ''
            || typeof edge.targetMachineId !== 'string' || edge.targetMachineId === '' || edge.sourceMachineId === edge.targetMachineId
            || !machines.has(edge.sourceMachineId) || !machines.has(edge.targetMachineId)
            || typeof edge.relationshipId !== 'string' || edge.relationshipId === '') continue;
        const setup = normalizedSetup(edge.setup);
        const disconnect = normalizedDisconnect(edge.disconnect);
        const normalized: CollaborationEdge = {
            sourceMachineId: edge.sourceMachineId,
            targetMachineId: edge.targetMachineId,
            relationshipId: edge.relationshipId,
            ...(setup === undefined ? {} : { setup }),
            ...(disconnect === undefined ? {} : { disconnect }),
        };
        const key = `${normalized.relationshipId}\0${normalized.sourceMachineId}\0${normalized.targetMachineId}`;
        const previous = edges.get(key);
        if (previous === undefined) edges.set(key, normalized);
        else if (previous.disconnect !== undefined || normalized.disconnect !== undefined) {
            const merged = { ...previous, disconnect: previous.disconnect ?? normalized.disconnect! };
            delete merged.setup;
            edges.set(key, merged);
        } else if (previous.setup?.repairNeeded || normalized.setup?.repairNeeded) {
            edges.set(key, { ...previous, setup: { ...(previous.setup ?? normalized.setup), repairNeeded: true } });
        }
    }
    const selectedMachineIds = [...new Set(source.selectedMachineIds.slice(0, 32).filter((id): id is string => typeof id === 'string' && machines.has(id)))];
    return { version: 1, selectedMachineIds, machines: [...machines.values()], edges: [...edges.values()] };
}

export async function loadCollaborationIntent(): Promise<CollaborationIntent> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyIntent();
    try { return normalizeIntent(JSON.parse(raw) as unknown) ?? emptyIntent(); }
    catch { return emptyIntent(); }
}

export async function saveCollaborationIntent(intent: CollaborationIntent): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(intent));
}

export function collaborationSummary(intent: CollaborationIntent): string {
    if (intent.selectedMachineIds.length < 2 && intent.edges.length === 0) return 'Off';
    if (intent.edges.some((edge) => edge.setup?.repairNeeded || edge.disconnect?.repair)) return 'Needs attention';
    if (intent.edges.some((edge) => edge.disconnect !== undefined)) return 'Disconnecting';
    if (intent.edges.some((edge) => edge.setup !== undefined)) return 'Setting up';
    return `${intent.selectedMachineIds.length} computers`;
}

export function hasMachineCollaboration(intent: CollaborationIntent, machineId: string): boolean {
    return intent.selectedMachineIds.includes(machineId)
        || intent.edges.some((edge) => edge.sourceMachineId === machineId || edge.targetMachineId === machineId);
}

export function hasPendingCollaboration(intent: CollaborationIntent): boolean {
    return (intent.selectedMachineIds.length >= 2 && intent.edges.length === 0)
        || intent.edges.some((edge) => edge.setup !== undefined || edge.disconnect !== undefined);
}

export function selectCollaborationMachines(
    current: CollaborationIntent,
    selected: CollaborationMachine[],
    newId: () => string = randomUUID,
): CollaborationIntent {
    if (selected.length !== 0 && (selected.length < 2 || selected.length > 6)) {
        throw new Error('Select between 2 and 6 computers.');
    }
    const next = cloneIntent(normalizeIntent(current) ?? emptyIntent());
    const selectedIds = selected.map((machine) => machine.machineId);
    const desired = new Set<string>();
    const existing = new Map(next.edges.map((edge) => [edgeKey(edge.sourceMachineId, edge.targetMachineId), edge]));

    for (const source of selected) {
        for (const target of selected) {
            if (source.machineId === target.machineId) continue;
            const key = edgeKey(source.machineId, target.machineId);
            desired.add(key);
            if (!existing.has(key)) {
                next.edges.push({
                    sourceMachineId: source.machineId,
                    targetMachineId: target.machineId,
                    relationshipId: `rel_${newId()}`,
                    setup: {},
                });
            }
        }
    }
    for (const edge of next.edges) {
        if (!desired.has(edgeKey(edge.sourceMachineId, edge.targetMachineId))) {
            edge.disconnect ??= { peerDeviceId: edge.setup?.peerDeviceId };
        }
    }

    const referenced = new Set([...selectedIds, ...next.edges.flatMap((edge) => [edge.sourceMachineId, edge.targetMachineId])]);
    const known = new Map(next.machines.map((machine) => [machine.machineId, machine]));
    for (const machine of selected) known.set(machine.machineId, { ...machine, name: safeName(machine.name) });
    next.selectedMachineIds = selectedIds;
    next.machines = [...known.values()].filter((machine) => referenced.has(machine.machineId));
    return next;
}

function mutation(current: PeerMutationMetadata | undefined, now: number, newId: () => string): PeerMutationMetadata {
    return current !== undefined && current.notValidAfter > now
        ? current
        : { operationId: newId(), notValidAfter: now + MUTATION_TTL_MS };
}

async function listPeers(machines: CollaborationMachine[], request: PeerRequester) {
    const entries = await Promise.all(machines.map(async (machine) => {
        try {
            return [machine.machineId, (await request(machine.machineId, 'peer.list', {})).peers] as const;
        } catch {
            return [machine.machineId, undefined] as const;
        }
    }));
    return new Map(entries);
}

function relationship(
    lists: Map<string, PeerRelationship[] | undefined>,
    machineId: string,
    relationshipId: string,
    direction: 'inbound' | 'outbound',
): PeerRelationship | undefined {
    return lists.get(machineId)?.find((peer) => peer.relationshipId === relationshipId && peer.direction === direction);
}

function ensureMachineStates(intent: CollaborationIntent, lists: Map<string, PeerRelationship[] | undefined>): Record<string, CollaborationMachineState> {
    const states: Record<string, CollaborationMachineState> = {};
    const selected = new Set(intent.selectedMachineIds);
    for (const machine of intent.machines) {
        const edges = intent.edges.filter((edge) => edge.sourceMachineId === machine.machineId || edge.targetMachineId === machine.machineId);
        if (edges.some((edge) => edge.setup?.repairNeeded || edge.disconnect?.repair)) {
            states[machine.machineId] = 'Repair needed';
            continue;
        }
        if (edges.some((edge) => edge.disconnect !== undefined)) {
            states[machine.machineId] = 'Disconnecting';
            continue;
        }
        if (!selected.has(machine.machineId)) continue;
        if (edges.length === 0) {
            states[machine.machineId] = 'Setting up';
            continue;
        }
        let state: CollaborationMachineState = 'Connected';
        for (const edge of edges) {
            const source = lists.get(edge.sourceMachineId);
            const target = lists.get(edge.targetMachineId);
            const outbound = relationship(lists, edge.sourceMachineId, edge.relationshipId, 'outbound');
            const inbound = relationship(lists, edge.targetMachineId, edge.relationshipId, 'inbound');
            if (source === undefined || target === undefined) state = state === 'Repair needed' ? state : 'Waiting for computer';
            else if (edge.setup?.repairNeeded || (!edge.setup && (!isActive(outbound) || !isActive(inbound)))) state = 'Repair needed';
            else if (!isActive(outbound) || !isActive(inbound)) state = state === 'Repair needed' ? state : 'Setting up';
        }
        states[machine.machineId] = state;
    }
    return states;
}

async function reconcileIntent(intent: CollaborationIntent, lists: Map<string, PeerRelationship[] | undefined>): Promise<CollaborationIntent> {
    const next = cloneIntent(normalizeIntent(intent) ?? emptyIntent());
    const knownMachines = new Set(next.machines.map((machine) => machine.machineId));
    const canonical = new Map<string, { sourceMachineId: string; targetMachineId: string; outbound?: PeerRelationship; inbound?: PeerRelationship }>();
    for (const [hostMachineId, peers] of lists) {
        for (const peer of peers ?? []) {
            if (peer.state === 'revoked') continue;
            const sourceMachineId = peer.direction === 'outbound' ? hostMachineId : peer.machineId;
            const targetMachineId = peer.direction === 'outbound' ? peer.machineId : hostMachineId;
            if (!knownMachines.has(sourceMachineId) || !knownMachines.has(targetMachineId)) continue;
            const key = `${peer.relationshipId}\0${sourceMachineId}\0${targetMachineId}`;
            const entry = canonical.get(key) ?? { sourceMachineId, targetMachineId };
            entry[peer.direction] = peer;
            canonical.set(key, entry);
        }
    }
    const selected = new Set(next.selectedMachineIds);
    for (const [key, entry] of canonical) {
        const [relationshipId] = key.split('\0');
        let edge = next.edges.find((candidate) => candidate.relationshipId === relationshipId
            && candidate.sourceMachineId === entry.sourceMachineId && candidate.targetMachineId === entry.targetMachineId);
        if (edge === undefined) {
            edge = { sourceMachineId: entry.sourceMachineId, targetMachineId: entry.targetMachineId, relationshipId };
            next.edges.push(edge);
        }
        if (edge.disconnect !== undefined && isActive(entry.inbound)) {
            delete edge.disconnect.targetRevoked;
            delete edge.disconnect.targetMutation;
        }
        if (edge.disconnect === undefined) {
            selected.add(entry.sourceMachineId);
            selected.add(entry.targetMachineId);
            if (isActive(entry.outbound) && isActive(entry.inbound)) edge.setup = undefined;
            else if (lists.get(entry.sourceMachineId) !== undefined && lists.get(entry.targetMachineId) !== undefined
                && (isActive(entry.outbound) || edge.setup === undefined)) {
                edge.setup = { repairNeeded: true, peerDeviceId: entry.outbound?.peerDeviceId ?? entry.inbound?.peerDeviceId };
            } else if (edge.setup !== undefined) {
                edge.setup.peerDeviceId ??= entry.inbound?.peerDeviceId;
            }
        }
    }
    next.selectedMachineIds = [...selected];
    next.edges = next.edges.filter((edge) => {
        const sourceList = lists.get(edge.sourceMachineId);
        const targetList = lists.get(edge.targetMachineId);
        const outbound = relationship(lists, edge.sourceMachineId, edge.relationshipId, 'outbound');
        const inbound = relationship(lists, edge.targetMachineId, edge.relationshipId, 'inbound');
        if (edge.disconnect !== undefined && sourceList !== undefined && targetList !== undefined && isGone(outbound) && isGone(inbound)) return false;
        if (edge.disconnect === undefined && isActive(outbound) && isActive(inbound)) edge.setup = undefined;
        if (edge.disconnect === undefined && sourceList !== undefined && targetList !== undefined) {
            const partialRelationship = isActive(outbound) !== isActive(inbound);
            if ((edge.setup === undefined && (!isActive(outbound) || !isActive(inbound)))
                || isActive(outbound) && !isActive(inbound)) {
                edge.setup = { repairNeeded: true, peerDeviceId: outbound?.peerDeviceId ?? inbound?.peerDeviceId };
            } else if (partialRelationship && edge.setup !== undefined) {
                edge.setup.peerDeviceId ??= outbound?.peerDeviceId ?? inbound?.peerDeviceId;
            }
        }
        return true;
    });
    const referenced = new Set([...next.selectedMachineIds, ...next.edges.flatMap((edge) => [edge.sourceMachineId, edge.targetMachineId])]);
    next.machines = next.machines.filter((machine) => referenced.has(machine.machineId));
    return next;
}

export async function reconcileCollaboration(
    intent: CollaborationIntent,
    machines: CollaborationMachine[],
    request: PeerRequester,
): Promise<CollaborationReport> {
    const normalized = normalizeIntent(intent) ?? emptyIntent();
    const catalog = mergeMachines(normalized, machines);
    const lists = await listPeers(catalog, request);
    const next = await reconcileIntent({ ...normalized, machines: catalog }, lists);
    return {
        intent: next,
        states: ensureMachineStates(next, lists),
        reachableMachineIds: [...lists].filter(([, peers]) => peers !== undefined).map(([id]) => id),
        errors: {},
    };
}

function mergeMachines(intent: CollaborationIntent, machines: CollaborationMachine[]): CollaborationMachine[] {
    const merged = new Map(intent.machines.map((machine) => [machine.machineId, machine]));
    for (const machine of machines) merged.set(machine.machineId, { ...machine, name: safeName(machine.name) });
    return [...merged.values()];
}

export async function applyCollaboration(
    intent: CollaborationIntent,
    machines: CollaborationMachine[],
    request: PeerRequester,
    onProgress: (intent: CollaborationIntent) => Promise<void> = saveCollaborationIntent,
    now: () => number = Date.now,
    newId: () => string = randomUUID,
): Promise<CollaborationReport> {
    const normalized = normalizeIntent(intent) ?? emptyIntent();
    const catalog = mergeMachines(normalized, machines);
    const byId = new Map(catalog.map((machine) => [machine.machineId, machine]));
    const errors: Record<string, string> = {};
    let lists = await listPeers(catalog, request);
    let next = await reconcileIntent({ ...normalized, machines: catalog }, lists);
    await onProgress(next);

    const revokeEdge = async (edge: CollaborationEdge): Promise<boolean> => {
        const progress = edge.disconnect ??= { peerDeviceId: edge.setup?.peerDeviceId };
        const inbound = relationship(lists, edge.targetMachineId, edge.relationshipId, 'inbound');
        const outbound = relationship(lists, edge.sourceMachineId, edge.relationshipId, 'outbound');
        progress.peerDeviceId ??= inbound?.peerDeviceId ?? outbound?.peerDeviceId;
        if (!progress.targetRevoked) {
            if (lists.get(edge.targetMachineId) === undefined) return false;
            progress.targetMutation = mutation(progress.targetMutation, now(), newId);
            await onProgress(next);
            await request(edge.targetMachineId, 'peer.revoke', {
                relationshipId: edge.relationshipId,
                ...(progress.peerDeviceId === undefined ? {} : { peerDeviceId: progress.peerDeviceId }),
                mutation: progress.targetMutation,
            });
            progress.targetRevoked = true;
            await onProgress(next);
        }
        if (lists.get(edge.sourceMachineId) === undefined || !isGone(outbound) && progress.peerDeviceId === undefined) return false;
        progress.sourceMutation = mutation(progress.sourceMutation, now(), newId);
        await onProgress(next);
        await request(edge.sourceMachineId, 'peer.revoke', {
            relationshipId: edge.relationshipId,
            ...(progress.peerDeviceId === undefined ? {} : { peerDeviceId: progress.peerDeviceId }),
            mutation: progress.sourceMutation,
        });
        return true;
    };

    for (const edge of [...next.edges]) {
        if (edge.disconnect === undefined) continue;
        try {
            if (await revokeEdge(edge)) {
                if (edge.disconnect.repair) {
                    edge.relationshipId = `rel_${newId()}`;
                    edge.disconnect = undefined;
                    edge.setup = {};
                } else {
                    next.edges = next.edges.filter((candidate) => candidate !== edge);
                }
                await onProgress(next);
            }
        } catch (cause) {
            const message = safeError(cause);
            errors[edge.sourceMachineId] = message;
            errors[edge.targetMachineId] = message;
            // Target revocation must succeed before source cleanup. Persist and retry later.
        }
    }

    const desired = new Set<string>();
    for (const source of next.selectedMachineIds) {
        for (const target of next.selectedMachineIds) if (source !== target) desired.add(edgeKey(source, target));
    }
    for (const sourceMachineId of next.selectedMachineIds) {
        for (const targetMachineId of next.selectedMachineIds) {
            if (sourceMachineId === targetMachineId || next.edges.some((edge) => edgeKey(edge.sourceMachineId, edge.targetMachineId) === edgeKey(sourceMachineId, targetMachineId))) continue;
            next.edges.push({ sourceMachineId, targetMachineId, relationshipId: `rel_${newId()}`, setup: {} });
            await onProgress(next);
        }
    }
    for (const edge of next.edges) {
        if (!desired.has(edgeKey(edge.sourceMachineId, edge.targetMachineId)) || edge.disconnect !== undefined) continue;
        if (isActive(relationship(lists, edge.sourceMachineId, edge.relationshipId, 'outbound'))
            && isActive(relationship(lists, edge.targetMachineId, edge.relationshipId, 'inbound'))) continue;
        let activeMutation: 'prepareMutation' | 'authorizeMutation' | 'installMutation' | undefined;
        try {
            if (edge.setup?.repairNeeded) {
                edge.disconnect = {
                    repair: true,
                    peerDeviceId: relationship(lists, edge.sourceMachineId, edge.relationshipId, 'outbound')?.peerDeviceId
                        ?? relationship(lists, edge.targetMachineId, edge.relationshipId, 'inbound')?.peerDeviceId,
                };
                if (!await revokeEdge(edge)) continue;
                edge.relationshipId = `rel_${newId()}`;
                edge.disconnect = undefined;
                edge.setup = {};
                await onProgress(next);
            }
            const source = byId.get(edge.sourceMachineId);
            const target = byId.get(edge.targetMachineId);
            if (source === undefined || target === undefined || lists.get(source.machineId) === undefined || lists.get(target.machineId) === undefined) continue;
            const setup = edge.setup ??= {};
            const recoverableInbound = isActive(relationship(lists, edge.targetMachineId, edge.relationshipId, 'inbound'));
            if (setup.descriptor === undefined || setup.descriptor.claims.expiresAt <= now() && !recoverableInbound) {
                if (setup.descriptor?.claims.expiresAt !== undefined && setup.descriptor.claims.expiresAt <= now()) setup.prepareMutation = undefined;
                const reusePrepare = setup.prepareMutation !== undefined && setup.prepareMutation.notValidAfter > now();
                if (!reusePrepare) {
                    setup.sourceName = source.name;
                    setup.sourcePlatform = source.platform;
                }
                setup.sourceName ??= source.name;
                setup.sourcePlatform ??= source.platform;
                setup.prepareMutation = mutation(setup.prepareMutation, now(), newId);
                setup.authorizeMutation = undefined;
                setup.installMutation = undefined;
                setup.sealedBundle = undefined;
                setup.peerDeviceId = undefined;
                activeMutation = 'prepareMutation';
                await onProgress(next);
                const prepared = await request(source.machineId, 'peer.prepare', {
                    targetMachineId: target.machineId,
                    targetMachineSigningPublicKey: target.machineSigningPublicKey,
                    sourceName: setup.sourceName,
                    ...(setup.sourcePlatform === undefined ? {} : { sourcePlatform: setup.sourcePlatform }),
                    mutation: setup.prepareMutation,
                });
                activeMutation = undefined;
                if (prepared.descriptor.claims.sourceMachineId !== source.machineId
                    || prepared.descriptor.claims.sourceMachineSigningPublicKey !== source.machineSigningPublicKey) {
                    throw new PeerHostResponseError('The source computer returned a mismatched identity.', 'peer-source-mismatch');
                }
                setup.descriptor = prepared.descriptor;
                await onProgress(next);
            }
            if (setup.sealedBundle === undefined) {
                setup.authorizeMutation = mutation(setup.authorizeMutation, now(), newId);
                activeMutation = 'authorizeMutation';
                await onProgress(next);
                const authorized = await request(target.machineId, 'peer.authorize', {
                    descriptor: setup.descriptor,
                    capabilities: COLLABORATION_CAPABILITIES,
                    mutation: setup.authorizeMutation,
                    relationshipId: edge.relationshipId,
                });
                activeMutation = undefined;
                setup.sealedBundle = authorized.sealedBundle;
                setup.peerDeviceId = authorized.peerDeviceId;
                await onProgress(next);
            }
            setup.installMutation = mutation(setup.installMutation, now(), newId);
            activeMutation = 'installMutation';
            await onProgress(next);
            await request(source.machineId, 'peer.install', {
                targetMachineId: target.machineId,
                sealedBundle: setup.sealedBundle,
                mutation: setup.installMutation,
                relationshipId: edge.relationshipId,
            });
            activeMutation = undefined;
            edge.setup = undefined;
            await onProgress(next);
        } catch (cause) {
            if (cause instanceof PeerHostResponseError && edge.setup !== undefined) {
                if (cause.code === 'peer-already-authorized') edge.setup.repairNeeded = true;
                if (activeMutation !== undefined) edge.setup[activeMutation] = undefined;
                await onProgress(next);
            }
            const message = safeError(cause);
            errors[edge.sourceMachineId] = message;
            errors[edge.targetMachineId] = message;
            // Reachability and host truth are reconciled below; progress remains retryable.
        }
    }

    lists = await listPeers(catalog, request);
    next = await reconcileIntent(next, lists);
    await onProgress(next);
    return {
        intent: next,
        states: ensureMachineStates(next, lists),
        reachableMachineIds: [...lists].filter(([, peers]) => peers !== undefined).map(([id]) => id),
        errors,
    };
}
