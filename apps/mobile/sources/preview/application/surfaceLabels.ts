/** Human labels for surface offers, derived per kind: no raw ids, no loopback origins. */
import type { SurfaceEntry } from '@/catalog';

function directHost(url: string): string {
    if (url === 'about:blank') return 'Blank tab';
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

export function codeTarget(path: string, line?: number): string {
    if (path === '.') return 'Worktree root';
    const base = path.split('/').pop() ?? path;
    return line === undefined ? base : `${base}:${line}`;
}

/** Preview and Agent browser are the two named destinations; the label says which. */
export function surfaceLabel(offer: SurfaceEntry['offer']): string {
    if (offer.kind === 'browser-local') return `Local · ${offer.title}`;
    if (offer.kind === 'browser-direct') return `Site · ${directHost(offer.url)}`;
    // A named agent browser keeps its name; the safe site says where it is.
    if (offer.kind === 'browser-session') return offer.site === '' ? offer.title : `${offer.title} · ${offer.site}`;
    return `Code · ${codeTarget(offer.path, offer.line)}`;
}

export function surfaceIcon(offer: SurfaceEntry['offer']): string {
    return offer.kind === 'code-review' ? 'code-outline' : 'globe-outline';
}
