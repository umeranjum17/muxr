/**
 * Contract selfCheck: the wire carries the full event vocabulary, and every
 * declared type round-trips through the payload codec byte-identically.
 */
import { decodePayload, encodePayload, isPluginsInvalidatedFrame, parseClientFrame } from './wire.js';
import { SESSION_EVENT_TYPES, type SessionEventBody } from './sessionEvent.js';
import { isPeerCapabilities, peerCapabilityForRequest } from './peer.js';
import type { SessionInfo, SessionStatus } from './sessionState.js';

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
    assert(parseClientFrame({ type: 'client.hello', clientId: 'fresh-client' }).type === 'client.hello', 'valid client hello passes');
    for (const malformed of [null, { type: 'session.list', requestId: 'bad', params: null }]) {
        let rejected = false;
        try { parseClientFrame(malformed); } catch { rejected = true; }
        assert(rejected, 'malformed client frame is rejected before host access');
    }
    process.stdout.write(`PASS: contract selfCheck (${events.length} event types, plugin frames, peer allowlist)\n`);
}

demo();
