/**
 * A URL the Agent printed. The URL string is not an Agent Route.
 */
export class TerminalLink {
    constructor(readonly url: string) {}

    display(maxLength: number): string {
        const parsed = new URL(this.url);
        const prefix = `${parsed.protocol}//${parsed.host}`;
        const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        const remaining = maxLength - prefix.length;
        if (remaining <= 1) return prefix;
        if (suffix.length > remaining) return `${prefix}${suffix.slice(0, remaining - 1)}…`;
        return `${prefix}${suffix}`;
    }

}

export function displayLink(url: string, maxLength: number): string {
    return new TerminalLink(url).display(maxLength);
}
