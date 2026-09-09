import { parseVoiceReportInput, type VoiceReport } from '../domain/voiceReport';

export type ReportAgentOutcomeCommand = {
    identity: string;
    sessionId: string;
    from: string;
    status: string;
    agentName?: string;
    taskTitle?: string;
};

export type ReportAgentOutcomeSnapshot = {
    deliveredIds: readonly string[];
    pendingIdentities: readonly string[];
    watching: boolean;
};

export type ReportAgentOutcomeResult =
    | { ok: false; reason: 'invalid' }
    | { ok: true; action: 'already-delivered' | 'skip-unwatched' | 'admit'; report: VoiceReport };

/** Admit a Voice Report. Parse fails closed. Agent Name must not be an internal id. */
export function reportAgentOutcome(
    command: ReportAgentOutcomeCommand,
    snapshot: ReportAgentOutcomeSnapshot,
): ReportAgentOutcomeResult {
    const parsed = parseVoiceReportInput(command);
    if (!parsed.ok) return { ok: false, reason: 'invalid' };
    if (snapshot.deliveredIds.includes(command.identity)) {
        return { ok: true, action: 'already-delivered', report: parsed.report };
    }
    const persisted = snapshot.pendingIdentities.includes(command.identity);
    if (!persisted && !snapshot.watching) {
        return { ok: true, action: 'skip-unwatched', report: parsed.report };
    }
    return { ok: true, action: 'admit', report: parsed.report };
}
