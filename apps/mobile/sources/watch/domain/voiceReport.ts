import { lifecycleIsRoutineVoice } from './lifecycle';

const MAX_VOICE_ATTEMPTS = 1_000;
const MAX_VOICE_READY_AHEAD_MS = 30_000;
const MAX_VOICE_IDENTITY_LENGTH = 200;
const MAX_VOICE_AGENT_NAME = 80;
const MAX_VOICE_TASK_TITLE = 200;

const VOICE_STATUSES = new Set(['idle', 'done', 'blocked', 'failed']);
const VOICE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const VOICE_CREDENTIAL_PATTERN = /(?:authorization\s*[:=]|bearer\s+[a-z0-9._-]{8,}|(?:api[ _-]?key|apikey|token|secret|password|credential)\s*[:=]\s*\S+|\bkey\s*[:=]\s*[a-z0-9._-]{8,}|\bsk-[a-z0-9_-]{8,}|\bacctok[a-z0-9_-]*|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const VOICE_INTERNAL_REFERENCE_PATTERN = /\b(?:pph?_[a-z0-9]+|(?:w\d+[A-Za-z]?):(?:p|t)\d+|(?:machine|device|session|pane|rel|peer)[-_][a-z0-9_-]{6,})\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i;
const VOICE_SCOPE_INTERNAL_REFERENCE_PATTERN = /\b(?:pph?_[a-z0-9]+|(?:w\d+[A-Za-z]?):(?:p|t)\d+|(?:session|pane|rel|peer)[-_][a-z0-9_-]{6,})\b/i;
const VOICE_PATH_PATTERN = /\bfile:\/\/\/|(?:^|[^a-z0-9_/])(?:~\/|\/(?!\/)[^\s<>"'`]+|[a-z]:[\\/][^\s<>"'`]*|\\\\[^\s\\]+\\[^\s<>"'`]*)/i;
const VOICE_INSTRUCTION_PATTERN = /(?:\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the)\s+)?(?:previous|prior|earlier|above|system|developer)\s+(?:instructions?|directions?|messages?|rules?)\b|\b(?:system|developer)\s+prompt\b|\b(?:reveal|repeat|print|show)\s+(?:the\s+)?(?:system|developer)\s+prompt\b|\byou\s+are\s+(?:now|chatgpt|an?\s+assistant)\b|\bact\s+as\b|(?:^|[\s<])(?:system|assistant|developer)\s*:|<(?:system|assistant|developer)\b)/i;

export interface VoiceReport {
    identity: string;
    sessionId: string;
    from: string;
    status: string;
    agentName: string;
    taskTitle: string;
    attempts: number;
    readyAt: number;
}

export type VoiceReportParse =
    | { ok: true; report: VoiceReport }
    | { ok: false };

export type VoiceAdmission = 'admitted' | 'pending' | 'delivered' | 'full' | 'invalid';

/** Spoken Agent Name must never be an internal route, pane id, or session id. */
export function agentNameIsTrusted(name: string): boolean {
    if (/^(?:pph?_|pane[_-]|session[_-])/i.test(name)) return false;
    if (/^[\w-]+:[\w-]+$/.test(name)) return false;
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(name)) return false;
    if (/[\\/]/.test(name)) return false;
    return true;
}

export function isTrustedVoiceScopeKey(value: string): boolean {
    if (value.length === 0 || value.length > MAX_VOICE_IDENTITY_LENGTH) return false;
    if (value !== value.trim()) return false;
    if (!/^[a-z0-9._:-]+$/i.test(value)) return false;
    if (VOICE_CONTROL_PATTERN.test(value)) return false;
    if (VOICE_CREDENTIAL_PATTERN.test(value)) return false;
    if (VOICE_SCOPE_INTERNAL_REFERENCE_PATTERN.test(value)) return false;
    if (VOICE_INSTRUCTION_PATTERN.test(value.replace(/[_-]+/g, ' '))) return false;
    return true;
}

function boundedVoiceAttempts(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
    return Math.min(Math.floor(value), MAX_VOICE_ATTEMPTS);
}

function boundedVoiceReadyAt(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
    return Math.min(value, Date.now() + MAX_VOICE_READY_AHEAD_MS);
}

/**
 * A Voice Report is invalid until current-schema validation. Presentation
 * metadata never authorizes: Agent Route (session id) and identity do.
 */
export function parseVoiceReport(value: unknown): VoiceReportParse {
    if (typeof value !== 'object' || value === null) return { ok: false };
    const entry = value as Partial<VoiceReport> & { from?: string; agentName?: string; taskTitle?: string };
    const rawAgentName = typeof entry.agentName === 'string' ? entry.agentName : '';
    const rawTaskTitle = typeof entry.taskTitle === 'string' ? entry.taskTitle : '';
    const agentName = rawAgentName.trim().slice(0, MAX_VOICE_AGENT_NAME);
    const taskTitle = rawTaskTitle.trim().slice(0, MAX_VOICE_TASK_TITLE);
    const trustedText = `${agentName} ${taskTitle}`;
    if (typeof entry.identity !== 'string' || entry.identity === '' || entry.identity.length > MAX_VOICE_IDENTITY_LENGTH) {
        return { ok: false };
    }
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '' || entry.sessionId.length > MAX_VOICE_IDENTITY_LENGTH) {
        return { ok: false };
    }
    if (entry.from !== 'working') return { ok: false };
    if (typeof entry.status !== 'string' || !VOICE_STATUSES.has(entry.status)) return { ok: false };
    if (agentName === '' || taskTitle === '') return { ok: false };
    if (!agentNameIsTrusted(agentName)) return { ok: false };
    if (VOICE_PATH_PATTERN.test(taskTitle)) return { ok: false };
    if (VOICE_CONTROL_PATTERN.test(`${rawAgentName}${rawTaskTitle}`)) return { ok: false };
    if (VOICE_CREDENTIAL_PATTERN.test(trustedText)) return { ok: false };
    if (VOICE_INTERNAL_REFERENCE_PATTERN.test(trustedText)) return { ok: false };
    if (VOICE_INSTRUCTION_PATTERN.test(trustedText)) return { ok: false };
    return {
        ok: true,
        report: {
            identity: entry.identity,
            sessionId: entry.sessionId,
            from: 'working',
            status: entry.status,
            agentName,
            taskTitle,
            attempts: boundedVoiceAttempts(entry.attempts),
            readyAt: boundedVoiceReadyAt(entry.readyAt),
        },
    };
}

export function parseVoiceReportInput(input: {
    identity: string;
    sessionId: string;
    from: string;
    status: string;
    agentName?: string;
    taskTitle?: string;
}): VoiceReportParse {
    return parseVoiceReport({
        identity: input.identity,
        sessionId: input.sessionId,
        from: input.from,
        status: input.status,
        agentName: input.agentName,
        taskTitle: input.taskTitle,
        attempts: 0,
        readyAt: 0,
    });
}

export function sanitizePersistedVoiceReport(value: unknown): VoiceReport | null {
    const parsed = parseVoiceReport(value);
    return parsed.ok ? parsed.report : null;
}

export function voiceReportIsRoutine(report: Pick<VoiceReport, 'status'>): boolean {
    return lifecycleIsRoutineVoice(report.status);
}

export { MAX_VOICE_IDENTITY_LENGTH };
