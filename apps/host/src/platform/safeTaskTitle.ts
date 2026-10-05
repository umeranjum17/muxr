// Titles leave the host in lifecycle records and push notifications; keep the
// same privacy boundary for both consumers.
const SECRET_ASSIGNMENT = /(?:token|passw(?:or)?d|secret|credential|api[_-]?key|private[_-]?key)\w*\s*[=:]|\bauthorization\s*:|\bbearer\s+\S/i;

export function safeTaskTitle(value: string | undefined): string | undefined {
    if (typeof value !== 'string' || value === '' || value.length > 120 || /[\0-\x1F\x7F]/.test(value)) return undefined;
    const privacyProbe = value.normalize('NFKC').trimStart();
    if (/^(?:\/|[A-Za-z]:\\)/.test(privacyProbe) || SECRET_ASSIGNMENT.test(privacyProbe)) return undefined;
    return value;
}

/** A blocked agent's question, as it may leave the host: line breaks only, bounded, no secret assignments. */
export function safeQuestion(value: string | undefined): string | undefined {
    if (typeof value !== 'string' || value === '' || value.length > 300 || /[\0-\x09\x0B-\x1F\x7F]/.test(value)) return undefined;
    return SECRET_ASSIGNMENT.test(value.normalize('NFKC')) ? undefined : value;
}
