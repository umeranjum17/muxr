import * as React from 'react';
import { useRouter } from 'expo-router';
import { useSurfaceEntries } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { ToolRow } from '@/plugins/ui';
import { requestSurfaceFocus, useShownSurface } from '@/preview/application/surfaceFocus';
import { surfaceIcon, surfaceLabel } from '@/preview/application/surfaceLabels';

/**
 * The selected session's open surfaces, listed under Tools next to the
 * plugins' own entries: same row, same weight. A tap shows that surface in
 * the session; closing stays on the surface itself.
 */
export function SurfaceToolItems(props: { sessionId: string | undefined }): React.JSX.Element | null {
    const router = useRouter();
    const machineId = getCachedConnectionSettings().machineId;
    const sessionId = props.sessionId ?? '';
    const entries = useSurfaceEntries(machineId, sessionId);
    const shown = useShownSurface(sessionId);
    if (props.sessionId === undefined || entries.length === 0) return null;
    return (
        <>
            {entries.map((entry) => (
                <ToolRow
                    key={entry.handle}
                    compact
                    icon={surfaceIcon(entry.offer)}
                    label={surfaceLabel(entry.offer)}
                    active={shown === entry.offer.name}
                    onPress={() => {
                        router.navigate(`/session/${sessionId}`);
                        requestSurfaceFocus(sessionId, entry.offer.name);
                    }}
                />
            ))}
        </>
    );
}
