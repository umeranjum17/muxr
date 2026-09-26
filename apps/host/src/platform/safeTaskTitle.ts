// Titles leave the host in lifecycle records and push notifications; keep the
// same privacy boundary for both consumers.
export function safeTaskTitle(value: string | undefined): string | undefined {
    if (value === undefined || value === '' || value.length > 120 || /[\0-\x1F\x7F]/.test(value)) return undefined;
    const privacyProbe = value.normalize('NFKC').trimStart();
    if (/^(?:\/|[A-Za-z]:\\)|\b(?:token|password|secret|credential)\s*=/i.test(privacyProbe)) return undefined;
    return value;
}
