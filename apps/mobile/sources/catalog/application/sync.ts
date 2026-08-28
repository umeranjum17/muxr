import {
    AccountCredentialRejectedError,
    validateHostedAccountSession,
    type AccountSessionState,
    type AuthCredentials,
} from '@/account/session';
import { accountSurfaceApplies, hostedTransportReady } from '@/pairing/grant';
import type { AttentionEntry, HerdrTreeWorkspace, LifecycleEvent, PluginsInvalidatedFrame, PromptAttachment, SessionEvent, SessionStatus } from '@muxr/contract';
import { MAX_RPC_PER_DEVICE, MAX_RPC_PER_PLUGIN } from '@muxr/contract';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { AttachmentPreview } from '../infrastructure/attachmentTypes';
import { Modal } from '@/modal';
import { Encryption } from '../infrastructure/encryption/encryption';
import type { DecryptedArtifact } from '../infrastructure/artifactTypes';
import { MuxrClient } from '@/pairing/client';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import {
    DEFAULT_CONNECTION,
    getCachedConnectionSettings,
    loadConnectionSettingsAsync,
} from '@/connection';
import { getCachedHostedGrant, loadHostedGrant, refreshHostedGrant } from '@/pairing/e2ee';
import { storage } from './storage';
import {
    applyStatusToSession,
    machineInfoToMachine,
    sessionInfoToSession,
} from '../infrastructure/sessionMapping';
import { agentStatusUnchanged, applyHostInfoToAgent, agentNameForNotice } from '../domain/agent';
import { lifecycleIsWorking, lifecycleWatchOutcome, watchAgentLifecycle } from '@/watch';
import { promptAgent } from './promptAgent';
import type { Settings } from './settings';
import { lifecycleNotificationCopy } from '@/utils/herd';

/** A shell that never reports back must not pin the promise forever. */
const SHELL_TIMEOUT_MS = 120_000;

const LIFECYCLE_CATALOG_UNAVAILABLE_CODES = new Set([
    'host-contract-mismatch',
    'method-not-found',
    'unsupported',
]);

function lifecycleCatalogUnavailable(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error
        && LIFECYCLE_CATALOG_UNAVAILABLE_CODES.has(String(error.code));
}

function socketStatusFromClient(state: string): 'connected' | 'connecting' | 'error' | 'disconnected' {
    if (state === 'open') return 'connected';
    if (state === 'connecting') return 'connecting';
    if (state === 'stale') return 'error';
    return 'disconnected';
}

function waitUntilClientOpen(client: MuxrClient, timeoutMs: number): Promise<void> {
    if (client.state === 'open') return Promise.resolve();
    return new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs);
        const off = client.onStateChange((state) => {
            if (state === 'open') {
                clearTimeout(timeout);
                off();
                resolve();
            }
        });
    });
}

/**
 * FIFO client admission for plugin RPCs. The host deliberately rejects callers
 * above its per-device ceiling; queueing here makes every plugin surface share
 * that budget instead of racing and permanently dropping reads/events.
 */
class PluginExecutionGate {
    private active = 0;
    private readonly activeByPlugin = new Map<string, number>();
    private readonly queue: Array<{ pluginId: string; resolve: () => void }> = [];

    async run<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
        await new Promise<void>((resolve) => {
            this.queue.push({ pluginId, resolve });
            this.drain();
        });
        try { return await operation(); }
        finally {
            this.active -= 1;
            const next = (this.activeByPlugin.get(pluginId) ?? 1) - 1;
            if (next === 0) this.activeByPlugin.delete(pluginId);
            else this.activeByPlugin.set(pluginId, next);
            this.drain();
        }
    }

    private drain(): void {
        while (this.active < MAX_RPC_PER_DEVICE && this.queue.length > 0) {
            const head = this.queue[0]!;
            if ((this.activeByPlugin.get(head.pluginId) ?? 0) >= MAX_RPC_PER_PLUGIN) return;
            this.queue.shift();
            this.active += 1;
            this.activeByPlugin.set(head.pluginId, (this.activeByPlugin.get(head.pluginId) ?? 0) + 1);
            head.resolve();
        }
    }
}

const pluginExecutionGate = new PluginExecutionGate();

class ConcurrencyGate {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    async run<T>(operation: () => Promise<T>): Promise<T> {
        await new Promise<void>((resolve) => {
            if (this.active < MAX_RPC_PER_DEVICE) { this.active += 1; resolve(); }
            else this.queue.push(resolve);
        });
        try { return await operation(); }
        finally {
            const next = this.queue.shift();
            if (next === undefined) this.active -= 1;
            else next();
        }
    }
}

// Event hooks may read many panes at once; keep that socket/host burst bounded.
const paneReadGate = new ConcurrencyGate();

export interface ShellOutcome {
    stdout: string;
    exitCode: number;
    isError: boolean;
    timedOut?: boolean;
}

type SendMessageOptions = {
    displayText?: string;
    source?: string;
    attachments?: AttachmentPreview[];
};

/*
 * Attachments ride inline as base64 in session.prompt. There is no blob store:
 * the host saves them to the workspace and Pi reads them from there.
 *
 * ponytail: inline with a hard cap, matching the tool-result direction. Swap in
 * a relay blob reference if attachments start exceeding it.
 */
const MAX_ATTACHMENT_BYTES = 1_000_000;

let accountCredentialRejectedHandler: (() => void) | undefined;
let pendingAccountCredentialRejection = false;
const pluginInvalidationHandlers = new Set<(frame: PluginsInvalidatedFrame) => void>();

function reconcilePluginCaches(frame: PluginsInvalidatedFrame): void {
    for (const handler of pluginInvalidationHandlers) {
        try { handler(frame); } catch { /* one optional cache must not block the others */ }
    }
}

export function registerPluginInvalidationHandler(handler: (frame: PluginsInvalidatedFrame) => void): () => void {
    pluginInvalidationHandlers.add(handler);
    return () => pluginInvalidationHandlers.delete(handler);
}

export function setAccountCredentialRejectedHandler(handler: (() => void) | undefined): void {
    accountCredentialRejectedHandler = handler;
    if (handler !== undefined && pendingAccountCredentialRejection) {
        pendingAccountCredentialRejection = false;
        handler();
    }
}

async function toPromptAttachments(previews: readonly AttachmentPreview[]): Promise<PromptAttachment[]> {
    return Promise.all(previews.map(async (preview) => {
        // fetch handles file://, content:// and web blob: alike, so no platform split.
        const bytes = new Uint8Array(await (await fetch(preview.uri)).arrayBuffer());
        const data = encodeBase64(bytes);
        if (data.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(`Attachment "${preview.name}" is too large to send`);
        }
        return { name: preview.name, mimeType: preview.mimeType, data };
    }));
}

class MuxrSync {
    private client: MuxrClient | undefined;
    private credentials: AuthCredentials | undefined;
    private accountValidation: Promise<AccountSessionState> | undefined;
    private pendingShell = new Map<string, (outcome: ShellOutcome) => void>();
    private openedSessions = new Set<string>();
    private opening = new Map<string, Promise<void>>();
    private activeMachineId: string | undefined;
    private herdrTreeRequest = 0;
    private presentingLifecycleIds = new Set<string>();
    encryption!: Encryption;
    anonID = 'muxr-local';
    serverID = 'muxr-local';

    private getConnection() {
        return getCachedConnectionSettings();
    }

    private hasTransport(): boolean {
        const settings = this.getConnection();
        return hostedTransportReady(settings.mode, settings.machineId, getCachedHostedGrant(settings.machineId));
    }

    async refreshAccountSession(): Promise<AccountSessionState> {
        const settings = this.getConnection();
        if (this.credentials === undefined) return 'valid';
        if (!accountSurfaceApplies(settings.mode, settings.selfhost, getCachedHostedGrant(settings.machineId)?.source)) return 'valid';
        if (this.accountValidation !== undefined) return this.accountValidation;
        this.accountValidation = validateHostedAccountSession(settings.relayUrl, this.credentials.token)
            .catch((error) => {
                if (error instanceof AccountCredentialRejectedError) {
                    if (accountCredentialRejectedHandler === undefined) pendingAccountCredentialRejection = true;
                    else accountCredentialRejectedHandler();
                }
                throw error;
            })
            .finally(() => { this.accountValidation = undefined; });
        return this.accountValidation;
    }

    private ensureClient(): MuxrClient {
        if (this.client !== undefined) return this.client;
        const settings = this.getConnection();
        const hostedGrant = settings.mode === 'hosted' ? getCachedHostedGrant(settings.machineId) : undefined;
        if (!hostedTransportReady(settings.mode, settings.machineId, hostedGrant)) {
            throw new Error('machine transport unavailable until secure pairing completes');
        }
        const transportToken = settings.mode === 'hosted' ? hostedGrant?.credential : settings.token.trim();
        const client = new MuxrClient({
            mode: settings.mode,
            relayUrl: hostedGrant?.relayUrl ?? settings.relayUrl,
            machineId: settings.machineId,
            ...(transportToken ? {
                // Discovery chooses where to dial; only the stored grant may
                // choose the reconnect credential.
                token: transportToken,
            } : {}),
            ...(hostedGrant === undefined ? {} : { hostedGrant }),
            ...(settings.mode === 'hosted' ? {
                onTicketRejected: () => { void this.refreshAccountSession().catch(() => undefined); },
                onPermanentError: (message: string) => storage.getState().setSocketError(message),
            } : {}),
        });
        client.onPluginsInvalidated?.((frame) => reconcilePluginCaches(frame));
        client.onStateChange((state) => {
            storage.getState().setSocketStatus(socketStatusFromClient(state));
            // Events emitted while the socket was down are gone: nothing replays them.
            // Re-open from the host snapshot instead of leaving a stale transcript
            // that only a manual app reload could fix.
            if (state === 'open') {
                storage.getState().setSocketError(null);
                // Machine frames are edge-triggered; reconnect/mount paths also
                // reconcile caches so a lost wakeup cannot leave stale UI.
                reconcilePluginCaches({ type: 'plugins.invalidated', reason: 'changed', pluginIds: [] });
                void this.refreshHerdTree().catch(() => undefined);
                for (const sessionId of [...this.openedSessions]) this.resync(sessionId);
                // Session events are not replayed after a disconnect. Always
                // reconcile the catalog or Spaces can show a pane that Live and
                // file links do not know exists.
                void this.refreshCatalog().catch(() => undefined);
            }
        });
        client.onEvent((sessionId, event) => this.handleSessionEvent(sessionId, event));
        client.connect();
        this.client = client;
        return client;
    }

    private handleSessionEvent(sessionId: string, event: SessionEvent): void {
        if (event.type === 'shell.end') {
            this.pendingShell.get(sessionId)?.({
                stdout: event.output ?? '',
                exitCode: event.exitCode ?? 1,
                isError: event.isError === true,
            });
            this.pendingShell.delete(sessionId);
        }

        if (event.type === 'status.update') {
            const session = storage.getState().sessions[sessionId];
            if (session === undefined) return;
            if (agentStatusUnchanged(session, event.status)) return;
            storage.getState().updateSession(sessionId, applyStatusToSession(session, event.status));
        }

        if (event.type === 'session.created') {
            storage.getState().applySessions([sessionInfoToSession(event.session)]);
        }

        if (event.type === 'session.updated') {
            const existing = storage.getState().sessions[sessionId];
            const fresh = sessionInfoToSession(event.session);
            if (existing === undefined) {
                storage.getState().applySessions([fresh]);
            } else {
                storage.getState().applySessions([applyHostInfoToAgent(existing, fresh)]);
            }
        }

        if (event.type === 'attention.update') {
            this.applyAttentionCatalog(event.catalog.entries);
        }

        if (event.type === 'lifecycle.update') {
            storage.getState().applyLifecycleEvent(event.event);
            void this.presentPendingLifecycleEvents();
        }

        if (event.type === 'watch.settled') {
            const agentName = agentNameForNotice(storage.getState().sessions[sessionId]);
            const rawStatus = event.timedOut === true ? 'timeout' : event.status.toLowerCase();
            const status = ['blocked', 'failed', 'done', 'idle', 'timeout', 'error'].includes(rawStatus) ? rawStatus : 'error';
            void this.scheduleSessionNotification(sessionId, `${agentName} ${lifecycleWatchOutcome(status)}.`);
        }

        if (event.type === 'session.removed') {
            storage.getState().deleteSession(sessionId);
        }

        // Topology only. Status ticks already updated the session row;
        // refetching the whole tree on every token made the phone hitch.
        if (
            event.type === 'session.created'
            || event.type === 'session.updated'
            || event.type === 'session.removed'
        ) {
            void this.refreshHerdTree().catch(() => undefined);
        }
    }

    /**
     * One source of truth for the inbox, the badge and the alert. A session that
     * newly needs a human is exactly what is worth interrupting for, so the
     * notification fires off the set entering, not off a separate event.
     */
    private applyAttentionCatalog(entries: readonly AttentionEntry[]): void {
        const previous = new Set(storage.getState().attentionEntries.map((entry) => entry.sessionId));
        storage.getState().applyAttentionCatalog([...entries]);
        if (storage.getState().lifecycleCatalogAvailable) return;
        if (AppState.currentState === 'active') return;
        for (const entry of entries) {
            if (previous.has(entry.sessionId) || Platform.OS === 'ios' || (Platform.OS === 'android' && entry.reason === 'done')) continue;
            const session = storage.getState().sessions[entry.sessionId];
            void this.scheduleSessionNotification(
                entry.sessionId,
                `${session?.metadata?.agentName?.trim() || 'Agent'} needs attention.`,
            );
        }
    }

    private async presentPendingLifecycleEvents(): Promise<void> {
        const pending = [...storage.getState().pendingLifecycleEvents]
            .sort((left, right) => {
                const leftDone = left.state === 'done' ? 1 : 0;
                const rightDone = right.state === 'done' ? 1 : 0;
                return leftDone - rightDone;
            });
        for (const event of pending) {
            if (this.presentingLifecycleIds.has(event.eventId)) continue;
            this.presentingLifecycleIds.add(event.eventId);
            try {
                if (Platform.OS !== 'web') {
                    await Notifications.scheduleNotificationAsync({
                        content: {
                            title: 'muxr',
                            body: lifecycleNotificationCopy(event),
                            data: { url: `/session/${encodeURIComponent(event.sessionId)}` },
                        },
                        trigger: null,
                    });
                }
                storage.getState().markLifecyclePresented(event.eventId);
            } catch (error) {
                console.error('lifecycle notification failed', error);
            } finally {
                this.presentingLifecycleIds.delete(event.eventId);
            }
        }
    }

    private async scheduleSessionNotification(sessionId: string, body: string): Promise<void> {
        // Android lifecycle notifications have one native owner and one stable
        // id. Posting the same attention/completion here through Expo created a
        // second notification for every transition.
        if (Platform.OS === 'android') return;
        try {
            const session = storage.getState().sessions[sessionId];
            const title = session?.metadata?.agentName?.trim() || 'Agent';
            await Notifications.scheduleNotificationAsync({
                content: {
                    title,
                    body,
                    data: { url: `/session/${encodeURIComponent(sessionId)}` },
                },
                trigger: null,
            });
        } catch (error) {
            console.error('session notification failed', sessionId, error);
        }
    }

    /**
     * The contract streams shell output as events; callers want one result.
     * Pi runs at most one shell per session, so a single pending slot is enough.
     * Quiet commands never enter the transcript: the host returns the outcome
     * as the request result instead of streaming shell.* events.
     */
    async runShell(sessionId: string, command: string, timeoutMs = SHELL_TIMEOUT_MS, quiet = false): Promise<ShellOutcome> {
        const client = this.ensureClient();
        if (quiet) {
            const outcome = await client.request('session.shell', { sessionId, command, quiet: true });
            return {
                stdout: outcome?.output ?? '',
                exitCode: outcome?.exitCode ?? 1,
                isError: outcome?.isError !== false,
            };
        }
        const settled = new Promise<ShellOutcome>((resolve) => {
            this.pendingShell.set(sessionId, resolve);
            setTimeout(() => {
                if (!this.pendingShell.has(sessionId)) return;
                this.pendingShell.delete(sessionId);
                resolve({ stdout: '', exitCode: 1, isError: true, timedOut: true });
            }, timeoutMs);
        });
        await client.request('session.shell', { sessionId, command });
        return settled;
    }

    async refreshHerdTree(): Promise<{ workspaces: HerdrTreeWorkspace[]; herdrConnected: boolean | undefined }> {
        const request = ++this.herdrTreeRequest;
        if (!this.hasTransport()) {
            storage.getState().setSocketStatus('disconnected');
            storage.getState().applyHerdrTree([]);
            await this.refreshAccountSession();
            return { workspaces: [], herdrConnected: undefined };
        }
        const tree = await this.ensureClient().request('herdr.tree', {});
        // Requests can cross when a done frame and a newer working frame arrive
        // close together. Only the latest canonical read may update the UI.
        if (request === this.herdrTreeRequest) storage.getState().applyHerdrTree(tree.workspaces);
        // The host adds `connected` (herdr runtime liveness) to this response.
        // A missing field means "unknown", not "healthy" — callers must only
        // treat an explicit false as a dead runtime.
        return { workspaces: tree.workspaces, herdrConnected: (tree as { connected?: boolean }).connected };
    }

    private async refreshCatalog(): Promise<void> {
        if (!this.hasTransport()) {
            storage.getState().setSocketStatus('disconnected');
            storage.getState().applyMachines([], true);
            storage.getState().applySessions([], true);
            storage.getState().applyHerdrTree([]);
            storage.getState().markSessionsLoaded();
            await this.refreshAccountSession();
            return;
        }
        const client = this.ensureClient();
        if (client.state !== 'open') await waitUntilClientOpen(client, 5000);
        const [machines, sessions, attention, lifecycle, tree] = await Promise.all([
            client.request('machines.list', {}),
            client.request('session.list', {}),
            client.request('attention.catalog', {}).catch(() => ({ revision: 0, entries: [] })),
            client.request('lifecycle.catalog', {}).catch((error: unknown) => {
                if (lifecycleCatalogUnavailable(error)) return undefined;
                throw error;
            }),
            this.refreshHerdTree().catch(() => undefined),
        ]);
        storage.getState().applyMachines(machines.map((machine) =>
            machineInfoToMachine(machine, getCachedHostedGrant(machine.machineId)?.machineName)
        ), true);
        // session.list carries no lifecycle and events are not replayed, so a
        // rebuilt catalog would otherwise show stale statuses until the next
        // real transition. The herd tree fetched alongside is the same host
        // truth the Spaces/notification surfaces use; fold it in.
        const statusBySession = new Map<string, SessionStatus['agentStatus']>();
        for (const workspace of tree?.workspaces ?? []) {
            for (const tab of workspace.tabs) {
                for (const pane of tab.panes) {
                    if (pane.sessionId !== undefined) statusBySession.set(pane.sessionId, pane.agentStatus);
                }
            }
        }
        storage.getState().applySessions(sessions.map((info) => {
            const agentStatus = statusBySession.get(info.id);
            return sessionInfoToSession(info, agentStatus === undefined ? undefined : {
                sessionId: info.id,
                agentStatus,
                isStreaming: lifecycleIsWorking(agentStatus),
                tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            });
        }), true);
        storage.getState().markSessionsLoaded();
        storage.getState().applyAttentionCatalog(attention.entries);
        if (lifecycle !== undefined) {
            storage.getState().applyLifecycleCatalog(lifecycle);
            void this.presentPendingLifecycleEvents();
        }
    }

    /** Re-hydrate a session from the host after a gap. Host state is the truth. */
    private resync(sessionId: string): void {
        // An open already in flight fetches a fresh snapshot anyway.
        if (this.opening.has(sessionId)) return;
        this.openedSessions.delete(sessionId);
        void this.openSession(sessionId).catch((error: unknown) => {
            console.error('resync failed', sessionId, error);
        });
    }

    /*
     * Screen mount, socket re-open and a fold gap all open the same session, and
     * the snapshot round trips take long enough to overlap. Two concurrent opens
     * each replace the whole transcript, which reads as it flickering between old
     * and empty, so callers share one in-flight open.
     */
    private openSession(sessionId: string): Promise<void> {
        if (this.openedSessions.has(sessionId)) return Promise.resolve();
        const inflight = this.opening.get(sessionId);
        if (inflight !== undefined) return inflight;
        const open = this.loadSession(sessionId).finally(() => this.opening.delete(sessionId));
        this.opening.set(sessionId, open);
        return open;
    }

    private async loadSession(sessionId: string): Promise<void> {
        const client = this.ensureClient();
        const snapshot = await client.request('session.open', { sessionId });
        const opened = applyStatusToSession(sessionInfoToSession(snapshot.info, snapshot.status), snapshot.status);
        // updateSession no-ops when the session is not in the map yet (catalog
        // failed to load); a successful open is proof enough it exists.
        if (storage.getState().sessions[sessionId] === undefined) {
            storage.getState().applySessions([opened]);
        } else {
            storage.getState().updateSession(sessionId, opened);
        }
        this.openedSessions.add(sessionId);
    }

    private async initEncryption(credentials: AuthCredentials): Promise<void> {
        const secretKey = decodeBase64(credentials.secret, 'base64url');
        if (secretKey.length !== 32) {
            throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
        }
        this.encryption = await Encryption.create(secretKey);
        this.anonID = this.encryption.anonID;
        this.serverID = credentials.token;
    }

    private async bootstrap(credentials: AuthCredentials): Promise<void> {
        this.client?.close();
        this.client = undefined;
        this.credentials = credentials;
        await this.initEncryption(credentials);
        const settings = await loadConnectionSettingsAsync();
        storage.getState().setLifecycleAuthority(this.anonID);
        watchAgentLifecycle(
            { authority: this.anonID, machineId: settings.machineId },
            { setScope: (scope) => storage.getState().setLifecycleScope(scope) },
        );
        const switchedMachine = this.activeMachineId !== undefined && this.activeMachineId !== settings.machineId;
        this.activeMachineId = settings.machineId;
        if (switchedMachine) {
            this.openedSessions.clear();
            this.opening.clear();
            this.herdrTreeRequest += 1;
            storage.getState().applyMachines([], true);
            storage.getState().applySessions([], true);
            storage.getState().applyHerdrTree([]);
        }
        if (settings.mode === 'hosted' && settings.machineId !== '') {
            await loadHostedGrant(settings.machineId);
            await refreshHostedGrant(settings.machineId);
        }
        // Account validation and machine transport are deliberately independent.
        // Offline/account-only startup renders immediately; only a definite /v1/session
        // 401 clears credentials, through the AuthContext rejection handler.
        void this.refreshCatalog().catch(() => undefined);
        storage.getState().applyReady();
    }

    async create(credentials: AuthCredentials): Promise<void> {
        await this.bootstrap(credentials);
    }

    async restore(credentials: AuthCredentials): Promise<void> {
        await this.bootstrap(credentials);
    }

    async sendMessage(sessionId: string, text: string, options?: SendMessageOptions): Promise<void> {
        const previews = options?.attachments ?? [];
        if (text.trim().length === 0 && previews.length === 0) return;
        const client = this.ensureClient();
        // No optimistic echo: the host emits message.append for the prompt, so the
        // transcript fold owns ordering and there is nothing to reconcile.
        // Steer, don't follow up: a message typed mid-turn is a correction, so it
        // lands at the next turn boundary instead of waiting for the run to settle.
        // The host ignores this while idle, where nothing is queued.
        await promptAgent(
            { agentRoute: sessionId, text, hasAttachments: previews.length > 0 },
            {
                markSent: (agentRoute) => storage.getState().updateSession(agentRoute, { lastMessageSentAt: Date.now() }),
                attachments: () => toPromptAttachments(previews),
                deliver: ({ agentRoute, text: prompt, streamingBehavior, attachments }) => client.request('session.prompt', {
                    sessionId: agentRoute,
                    text: prompt,
                    streamingBehavior,
                    ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
                }),
            },
        );
    }

    applySettings(patch: Partial<Settings>): void {
        storage.getState().applySettingsLocal(patch);
    }

    refreshSessions = async (): Promise<void> => {
        await this.refreshCatalog();
    };

    refreshMachines = async (): Promise<void> => {
        await this.refreshCatalog();
    };

    fetchArtifactsList = async (): Promise<void> => {};

    fetchArtifactWithBody = async (_artifactId: string): Promise<DecryptedArtifact | null> => null;

    createArtifact = async (
        _title: string | null,
        _body: string | null,
        _sessions?: string[],
        _draft?: boolean,
    ): Promise<string> => {
        throw new Error('muxr mobile: artifacts not wired');
    };

    updateArtifact = async (
        _artifactId: string,
        _title: string | null,
        _body: string | null,
        _sessions?: string[],
        _draft?: boolean,
    ): Promise<void> => {};

    getCredentials(): AuthCredentials | undefined {
        return this.credentials;
    }

    async request<T extends import('@muxr/contract').RequestType>(
        type: T,
        params: import('@muxr/contract').RequestParams<T>,
        timeoutMs?: number,
    ): Promise<import('@muxr/contract').RequestResult<T>> {
        const client = this.ensureClient();
        if (client.state !== 'open') {
            // Cold starts (deep links, app relaunch straight into a session)
            // raced the socket: requests fired while it was still connecting
            // and failed with 'not connected'. Wait it out; the request's own
            // timeout still bounds a relay that never comes up.
            await waitUntilClientOpen(client, 10_000);
        }
        const request = () => client.request(type, params, timeoutMs);
        if (type === 'plugin.call' || type === 'plugin.invoke') {
            const pluginId = (params as import('@muxr/contract').RequestParams<'plugin.call'> | import('@muxr/contract').RequestParams<'plugin.invoke'>).pluginId;
            return pluginExecutionGate.run(pluginId, request) as Promise<import('@muxr/contract').RequestResult<T>>;
        }
        return type === 'pane.read'
            ? paneReadGate.run(request)
            : request();
    }

    /**
     * Drop the cached client so the next ensureClient() reads the settings that
     * were just saved. Without this a settings change does nothing until the app
     * restarts, which is the whole reason the screen exists.
     */
    async reconnect(): Promise<void> {
        this.client?.close();
        this.client = undefined;
        storage.getState().setSocketStatus(this.hasTransport() ? 'connecting' : 'disconnected');
        const settings = this.getConnection();
        watchAgentLifecycle(
            { authority: this.anonID, machineId: settings.machineId },
            { setScope: (scope) => storage.getState().setLifecycleScope(scope) },
        );
        await this.refreshCatalog();
    }
}

export const sync = new MuxrSync();

let initialized = false;

export async function syncCreate(credentials: AuthCredentials): Promise<void> {
    if (initialized) {
        await sync.create(credentials);
        return;
    }
    initialized = true;
    try {
        await sync.create(credentials);
    } catch (error) {
        initialized = false;
        throw error;
    }
}

export async function syncRestore(credentials: AuthCredentials): Promise<void> {
    if (initialized) return;
    initialized = true;
    try {
        await sync.restore(credentials);
    } catch (error) {
        initialized = false;
        throw error;
    }
}

export async function syncReconnect(): Promise<void> {
    await sync.reconnect();
}

export { DEFAULT_CONNECTION };
