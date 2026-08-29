/**
 * A URL the Agent printed. Loopback HTML can open as Preview; everything else
 * opens externally. The URL string is not an Agent Route.
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

    /** Loopback URLs can be tunnelled into the preview WebView; the rest cannot. */
    loopbackPort(): number | undefined {
        try {
            const parsed = new URL(this.url);
            if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return undefined;
            if (parsed.port !== '') return Number(parsed.port);
            return parsed.protocol === 'https:' ? 443 : 80;
        } catch {
            return undefined;
        }
    }

    chipKind(contentType: string | null): 'preview' | 'open' {
        if (contentType !== null && contentType.toLowerCase().startsWith('text/html')) return 'preview';
        return 'open';
    }

    isPreviewable(contentType: string | null): boolean {
        return this.loopbackPort() !== undefined && this.chipKind(contentType) === 'preview';
    }
}


export function displayLink(url: string, maxLength: number): string {
    return new TerminalLink(url).display(maxLength);
}

export function loopbackPort(url: string): number | undefined {
    return new TerminalLink(url).loopbackPort();
}

export function chipKindFromContentType(contentType: string | null): 'preview' | 'open' {
    return new TerminalLink('http://localhost').chipKind(contentType);
}
