import * as React from 'react';
import { router } from 'expo-router';
import { sync } from '@/catalog/sync';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { subscribeTerminalLinks, viewportTerminalLinks } from './recentOutput';
import { chipKindFromContentType, loopbackPort } from '../domain/TerminalLink';

export function useTerminalChipLink(sessionId: string) {
    const [chipLink, setChipLink] = React.useState<string | undefined>(undefined);
    const [chipKind, setChipKind] = React.useState<'preview' | 'open' | undefined>(undefined);
    const chipKindCache = React.useRef(new Map<string, 'preview' | 'open'>());

    React.useEffect(() => {
        const refresh = (id?: string) => {
            if (id !== undefined && id !== sessionId) return;
            const link = viewportTerminalLinks(sessionId)[0];
            setChipLink((previous) => (previous === link ? previous : link));
        };
        refresh();
        return subscribeTerminalLinks(refresh);
    }, [sessionId]);

    // localhost + html is a web app worth a Preview; anything else only opens
    // externally. The probe runs on the host, where the port actually is.
    React.useEffect(() => {
        if (chipLink === undefined) {
            setChipKind(undefined);
            return;
        }
        const cached = chipKindCache.current.get(chipLink);
        if (cached !== undefined) {
            setChipKind(cached);
            return;
        }
        const port = loopbackPort(chipLink);
        if (port === undefined) {
            chipKindCache.current.set(chipLink, 'open');
            setChipKind('open');
            return;
        }
        let cancelled = false;
        setChipKind(undefined);
        void sync.request('preview.probe', { port })
            .then(({ contentType }) => {
                const kind = chipKindFromContentType(contentType);
                chipKindCache.current.set(chipLink, kind);
                if (!cancelled) setChipKind(kind);
            })
            .catch(() => {
                // Older hosts have no probe; an external open always works.
                if (!cancelled) setChipKind('open');
            });
        return () => { cancelled = true; };
    }, [chipLink]);

    const openChipLink = React.useCallback(() => {
        if (chipLink === undefined || chipKind === undefined) return;
        if (chipKind === 'preview') {
            const port = loopbackPort(chipLink);
            if (port !== undefined) router.push(`/session/${encodeURIComponent(sessionId)}/preview?port=${port}` as never);
            return;
        }
        void openExternalUrl(chipLink);
    }, [chipLink, chipKind, sessionId]);

    return { chipLink, chipKind, openChipLink };
}
