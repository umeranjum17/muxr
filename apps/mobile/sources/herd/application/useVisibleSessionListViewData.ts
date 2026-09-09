import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/catalog/store';

export function useVisibleSessionListViewData(forceShowInactive = false): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions') && !forceShowInactive;

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const result: SessionListViewItem[] = [];

        // First pass: add active sessions group
        for (const item of data) {
            if (item.type === 'active-sessions') {
                result.push(item);
            }
        }

        // If not hiding, add all remaining items (headers, inactive sessions)
        if (!hideInactiveSessions) {
            for (const item of data) {
                if (item.type === 'active-sessions') {
                    continue; // already added
                }

                if (item.type === 'session') {
                    if (!item.session.active) {
                        result.push(item);
                    }
                    continue;
                }

                if (item.type === 'header') {
                    result.push(item);
                }
            }
        }

        return result;
    }, [data, hideInactiveSessions]);
}
