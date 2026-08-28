#!/usr/bin/env node

const DONE_TTL_MS = 6 * 60 * 60 * 1000;

function context() {
    try {
        const parsed = JSON.parse(process.env.MUXR_PLUGIN_CONTEXT_JSON ?? '{}');
        return {
            sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
            attention: Array.isArray(parsed.attention) ? parsed.attention : [],
        };
    } catch {
        return { sessions: [], attention: [] };
    }
}

function clean(value, max = 160) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined;
}

function time(value) {
    const parsed = Date.parse(typeof value === 'string' ? value : '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function basename(path) {
    const cleanPath = clean(path, 256);
    if (cleanPath === undefined || cleanPath === '/') return undefined;
    return cleanPath.replace(/\/+$/, '').split('/').pop() || undefined;
}

function workspace(session) {
    return clean(session?.workspaceLabel, 80) ?? basename(session?.cwd) ?? 'Other';
}

function kind(session) {
    return clean(session?.agentKind, 40) ?? 'Agent';
}

function rowFor(session, attention, now) {
    const status = clean(session?.agentStatus, 20);
    const reason = clean(attention?.reason, 20);
    const at = time(attention?.at) || time(session?.activeAt) || now;
    const base = {
        id: attention?.sessionId ?? session.sessionId,
        title: clean(session?.label, 80) ?? 'Agent',
        subtitle: clean(attention?.detail, 160) ?? clean(session?.cwd, 200),
        glyph: kind(session),
        timestamp: new Date(at).toISOString(),
        action: { type: 'kernel.navigate', target: 'session', sessionId: attention?.sessionId ?? session.sessionId },
    };
    if (status === 'blocked' || reason === 'waiting' || reason === 'blocked' || reason === 'failed') {
        return { bucket: 'needsYou', row: { ...base, status: 'danger', pulsing: true }, workspace: workspace(session) };
    }
    if (status === 'working') {
        return { bucket: 'working', row: { ...base, status: 'warning', pulsing: true }, workspace: workspace(session) };
    }
    if (status === 'done' || reason === 'done') {
        if (now - at > DONE_TTL_MS) return undefined;
        return { bucket: 'done', row: { ...base, status: 'positive' }, workspace: workspace(session) };
    }
    return undefined;
}

const { sessions, attention } = context();
const validSessions = sessions.filter((session) => typeof session?.sessionId === 'string');
const bySession = new Map(validSessions.map((session) => [session.sessionId, session]));
const attentionBySession = new Map(attention.filter((entry) => typeof entry?.sessionId === 'string').map((entry) => [entry.sessionId, entry]));
const seen = new Set();
const columns = { needsYou: [], working: [], done: [] };
const now = Date.now();

for (const entry of attentionBySession.values()) {
    const row = rowFor(bySession.get(entry.sessionId), entry, now);
    if (row === undefined) continue;
    seen.add(entry.sessionId);
    columns[row.bucket].push(row);
}
for (const session of validSessions) {
    if (seen.has(session.sessionId)) continue;
    const row = rowFor(session, attentionBySession.get(session.sessionId), now);
    if (row !== undefined) columns[row.bucket].push(row);
}

for (const bucket of Object.values(columns)) {
    bucket.sort((a, b) => time(a.row.timestamp) - time(b.row.timestamp));
}

if (process.argv[2] === 'count') {
    process.stdout.write(JSON.stringify({ count: columns.needsYou.length }));
    process.exit(0);
}

const grouped = new Map();
for (const bucket of ['needsYou', 'working', 'done']) {
    for (const entry of columns[bucket]) {
        const group = grouped.get(entry.workspace) ?? [];
        group.push(entry.row);
        grouped.set(entry.workspace, group);
    }
}
function workspaceOrder(left, right) {
    if (left === 'Other') return 1;
    if (right === 'Other') return -1;
    return left.localeCompare(right);
}

const groups = [...grouped.entries()]
    .sort(([a], [b]) => workspaceOrder(a, b))
    .map(([title, items], index) => ({ id: `group-${index + 1}`, title, items }));

process.stdout.write(JSON.stringify({ title: 'Inbox', groups }));
