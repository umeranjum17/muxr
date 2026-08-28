export type SessionEnvelopeKind = {
    role: 'user' | 'agent';
    turn?: string;
    usage?: unknown;
    ev: { t: string; text?: string };
};

/** Agent service envelope that carries token usage and no visible text. */
export function usageHeartbeat(envelope: SessionEnvelopeKind): boolean {
    if (envelope.role !== 'agent') return false;
    if (envelope.ev.t !== 'service') return false;
    if ((envelope.ev.text ?? '').trim().length !== 0) return false;
    return envelope.usage !== undefined;
}

export function turnlessAgent(envelope: SessionEnvelopeKind): boolean {
    return envelope.role === 'agent' && !envelope.turn;
}

/** Turnless agent envelopes are dropped unless they are a usage heartbeat. */
export function dropSessionEnvelope(envelope: SessionEnvelopeKind): boolean {
    return turnlessAgent(envelope) && !usageHeartbeat(envelope);
}
