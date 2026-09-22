const parseUrl = (url: string): URL | null => {
    try { return new URL(url); } catch { return null; }
};

/**
 * A URL the Agent printed. The URL string is not an Agent Route.
 */
export class TerminalLink {
    constructor(readonly url: string) {}

    display(maxLength: number): string {
        // A printed link is whatever the agent wrote, not necessarily a URL a
        // parser accepts: `http://` alone reaches here and throws. Showing the
        // raw text is worse than a parsed host and far better than taking the
        // menu down before Copy is reachable.
        const parsed = parseUrl(this.url);
        if (parsed === null) return this.url.length > maxLength ? `${this.url.slice(0, maxLength - 1)}…` : this.url;
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
