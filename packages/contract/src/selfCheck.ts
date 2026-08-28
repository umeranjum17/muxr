/**
 * Contract selfCheck: the wire carries the full event vocabulary, and every
 * declared type round-trips through the payload codec byte-identically.
 */
import { admitClientFrame, decodePayload, encodePayload, envelopeIsHosted, isPluginsInvalidatedFrame, parseClientFrame, tryParseClientFrame } from './control-plane/index.js';
import { SESSION_EVENT_TYPES, type SessionEventBody } from './herd/index.js';
import { admitPeerMutation, authorizePeerDispatch, deviceIsPeer, inspectPeerGrantConstraints, isPeerCapabilities, peerCapabilityForRequest, peerMayDispatch } from './peer/index.js';
import { boundRealtimePublicContext, parseRealtimeClientFrame, parseRealtimeHostFrame, realtimePcm16ByteLength, MAX_REALTIME_PUBLIC_SESSIONS } from './realtime/index.js';
import {
    agentIsWorking,
    attentionOutranks,
    attentionReasonStillHolds,
    ATTENTION_DONE_TTL_MS,
    ATTENTION_HARD_CAP_MS,
    isSessionIdle,
    normalizeAgentName,
    parseAgentName,
    parsePublicAgentRoute,
    type SessionInfo,
    type SessionStatus,
} from './herd/index.js';
import { interpretWorktreeLanding, landNeedsConsent, landSucceeded } from './worktree/index.js';
import { parsePluginId, parsePluginManifest, pluginIsCompatible } from './plugins/index.js';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const session: SessionInfo = {
    id: 'pp_check',
    cwd: '/tmp',
    path: 'w1:p1',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
    firstMessage: '',
    agentKind: 'pi',
    paneId: 'w1:p1',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    terminalTitle: 'pi · /tmp',
    worktree: { repo: 'muxr', branch: 'main', path: '/tmp/muxr' },
};

const status: SessionStatus = {
    sessionId: session.id,
    agentStatus: 'working',
    isStreaming: true,
    tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    cost: 0,
    usageLimits: { capturedAt: '2026-01-01T00:00:00.000Z', windows: [] },
};

const events: SessionEventBody[] = [
    { type: 'session.created', session },
    { type: 'session.updated', session },
    { type: 'session.error', message: 'boom' },
    { type: 'status.update', status },
    {
        type: 'activity.update',
        activity: { sessionId: session.id, phase: 'active', label: 'working', at: '2026-01-01T00:00:00.000Z' },
    },
    { type: 'attention.update', catalog: { revision: 1, entries: [] } },
    {
        type: 'lifecycle.update',
        event: {
            eventId: 'event-check',
            sessionId: session.id,
            displayName: 'Maria',
            state: 'working',
            reasonCode: 'agent-working',
            reason: 'agent-working',
            at: '2026-01-01T00:00:00.000Z',
        },
    },
    { type: 'watch.settled', status: 'done', detail: 'pi is done' },
    { type: 'session.removed' },
    { type: 'shell.start', command: 'ls' },
    { type: 'shell.chunk', chunk: 'file.txt\n' },
    { type: 'shell.end', output: 'file.txt\n', exitCode: 0 },
];

function demo(): void {
    assert(events.length === SESSION_EVENT_TYPES.length, 'fixture must cover every event type');
    const seen = new Set(events.map((event) => event.type));
    for (const type of SESSION_EVENT_TYPES) assert(seen.has(type), `fixture missing ${type}`);
    for (const event of events) {
        const roundTripped = decodePayload(encodePayload({ type: 'session.event', sessionId: session.id, event: { ...event, seq: 1 } })) as {
            type: string;
            event: SessionEventBody;
        };
        assert(roundTripped.type === 'session.event', 'envelope survives the codec');
        assert(JSON.stringify(roundTripped.event) === JSON.stringify({ ...event, seq: 1 }), `${event.type} round-trips identically`);
    }
    const invalidated = { type: 'plugins.invalidated' as const, reason: 'changed' as const, pluginIds: ['example.muxr-ui'] };
    assert(isPluginsInvalidatedFrame(decodePayload(encodePayload(invalidated))), 'plugin invalidation frame validates');
    assert(isPluginsInvalidatedFrame({ ...invalidated, pluginIds: [] }), 'empty informational plugin frame validates');
    assert(!isPluginsInvalidatedFrame({ ...invalidated, pluginIds: ['bad id'] }), 'invalid plugin id is rejected');
    assert(!isPluginsInvalidatedFrame({ ...invalidated, pluginIds: Array.from({ length: 33 }, () => 'example.muxr-ui') }), 'oversized plugin frame is rejected');
    assert(isPeerCapabilities(['list', 'read', 'status', 'watch', 'prompt']), 'default peer capabilities validate');
    assert(peerCapabilityForRequest('session.prompt') === 'prompt', 'safe peer requests map to their signed capability');
    assert(peerCapabilityForRequest('session.start') === 'start', 'advanced peer start stays separate');
    assert(peerCapabilityForRequest('session.shell') === undefined && peerCapabilityForRequest('herdr.cli') === undefined,
        'shell and raw herdr stay outside the peer surface');
    const publicContext = boundRealtimePublicContext({
        sessions: [
            { sessionId: 'pp_voice', displayName: 'pp_internal', taskTitle: 'pi - Realtime Stability', agentKind: 'pi' },
            { sessionId: 'bad/path', displayName: 'leaked', taskTitle: '/private/work' },
            ...Array.from({ length: MAX_REALTIME_PUBLIC_SESSIONS + 4 }, (_, index) => ({ sessionId: `pp_${index}`, displayName: `agent-${index}` })),
        ],
    });
    assert(publicContext.sessions.length === MAX_REALTIME_PUBLIC_SESSIONS, 'realtime public session map is bounded');
    assert(publicContext.sessions[0]?.taskTitle === 'Realtime Stability', 'realtime public task title strips provider prefix');
    assert(publicContext.sessions[0]?.displayName === 'Agent', 'internal or absent Agent Names remain present behind the unified fallback');
    assert(!publicContext.sessions.some((entry) => entry.sessionId === 'bad/path'), 'realtime public session map rejects unsafe routing ids');
    for (const action of ['pause_output', 'resume_output', 'output_drained'] as const) {
        const frame = parseRealtimeClientFrame({ type: 'realtime.control', action });
        assert(frame.type === 'realtime.control' && frame.action === action, `${action} control validates`);
    }
    const appRequest = parseRealtimeHostFrame({ type: 'realtime.app.request', requestId: 'app-1', action: 'navigate', target: 'settings' });
    assert(appRequest.type === 'realtime.app.request' && appRequest.target === 'settings', 'semantic app requests validate without coordinates or routes');
    const appResult = parseRealtimeClientFrame({ type: 'realtime.app.result', requestId: 'app-1', ok: true, text: 'Navigated to settings.' });
    assert(appResult.type === 'realtime.app.result' && appResult.ok, 'semantic app results validate on the realtime transport');
    assert(realtimePcm16ByteLength('AAA=') === 2, 'canonical PCM16 base64 reports decoded bytes');
    for (const malformed of ['AAA', 'AAB=', 'AAAA', 'AA==']) {
        let rejected = false;
        try { realtimePcm16ByteLength(malformed); } catch { rejected = true; }
        assert(rejected, 'malformed or non-PCM16 base64 is rejected');
    }
    assert(parseClientFrame({ type: 'client.hello', clientId: 'fresh-client' }).type === 'client.hello', 'valid client hello passes');
    assert(admitClientFrame({ frame: { type: 'client.hello', clientId: 'fresh-client' } }).ok, 'admit client frame is the named use case');
    assert(tryParseClientFrame({ type: 'client.hello', clientId: 'fresh-client' }).ok, 'client hello is an expected-success outcome');
    assert(!envelopeIsHosted({ machineId: 'm1', seq: 1, at: 0 }), 'local envelopes are not hosted');
    assert(!tryParseClientFrame(null).ok, 'malformed client frame is an expected rejection');
    for (const malformed of [null, { type: 'session.list', requestId: 'bad', params: null }]) {
        let rejected = false;
        try { parseClientFrame(malformed); } catch { rejected = true; }
        assert(rejected, 'malformed client frame is rejected before host access');
    }
    assert(agentIsWorking('working') && !agentIsWorking('blocked'), 'working is the only busy lifecycle');
    assert(!isSessionIdle(status) && isSessionIdle({ ...status, agentStatus: 'done', isStreaming: true }), 'herdr lifecycle outranks the streaming flag');
    assert(attentionOutranks('waiting', 'done') && attentionReasonStillHolds('waiting', ATTENTION_HARD_CAP_MS + 1), 'waiting outranks done and never decays');
    assert(!attentionReasonStillHolds('done', ATTENTION_DONE_TTL_MS + 1), 'done attention ages out');
    const internalName = parseAgentName('pp_hidden');
    assert(internalName.ok && internalName.value === 'Agent' && normalizeAgentName('pph_hidden') === 'Agent' && normalizeAgentName('Мария') === 'Мария' && !parsePublicAgentRoute('bad/path').ok, 'Agent Name normalization preserves real names, hides pp_ and pph_ names, and never authorizes routes');
    assert(peerMayDispatch(['prompt'], 'session.prompt') && !peerMayDispatch(['prompt'], 'session.start'), 'peer dispatch uses the signed allowlist');
    assert(authorizePeerDispatch({ allowlist: ['prompt'], requestType: 'session.prompt' }).ok, 'authorize peer dispatch admits a signed capability');
    assert(!authorizePeerDispatch({ allowlist: ['prompt'], requestType: 'session.start' }).ok, 'authorize peer dispatch denies start without start');
    assert(deviceIsPeer('peer') && !deviceIsPeer('native'), 'peer device kind is the only peer');
    assert(!inspectPeerGrantConstraints({ deviceKind: 'native', capabilities: ['list'] }).ok, 'peer constraints cannot ride on a native grant');
    assert(admitPeerMutation({ mutation: { operationId: 'op-1', notValidAfter: Date.now() + 60_000 }, now: Date.now() }).ok, 'fresh peer mutation is accepted');
    assert(!admitPeerMutation({ mutation: { operationId: 'op-1', notValidAfter: Date.now() - 1 }, now: Date.now() }).ok, 'expired peer mutation is rejected');
    assert(interpretWorktreeLanding({ status: 'already-landed', branch: 'feat', into: 'main' }).kind === 'succeeded', 'already-landed is a succeeded landing');
    assert(interpretWorktreeLanding({ status: 'blocked-dirty-base', files: ['a.ts'] }).kind === 'needs-consent', 'dirty base needs consent');
    assert(landSucceeded({ status: 'already-landed', branch: 'feat', into: 'main' }) && landNeedsConsent({ status: 'blocked-dirty-base', files: ['a.ts'] }), 'worktree landing states are decisions');
    assert(parsePluginId('example.muxr-ui').ok && !parsePluginId('bad id').ok, 'plugin identity rejects display-like names');
    assert(parsePluginManifest({ source: { schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [] } }).ok, 'parse plugin manifest admits a current graph');
    assert(pluginIsCompatible({ schemaVersion: 1, pluginId: 'example.muxr-ui', contributions: [] }), 'current manifests are compatible');
    process.stdout.write(`PASS: contract selfCheck (${events.length} event types, plugin frames, peer allowlist)\n`);
}

demo();
