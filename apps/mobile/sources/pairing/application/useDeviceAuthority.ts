import * as React from 'react';
import { Platform } from 'react-native';
import { useSocketStatus } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { currentDeviceAuthority, listPairedGrants } from './hostedE2ee';

export type DeviceAuthority = 'control' | 'observe';

export function useDeviceAuthority(): { authority: DeviceAuthority; loading: boolean } {
    const { status: socketStatus } = useSocketStatus();
    const connection = getCachedConnectionSettings();
    const [state, setState] = React.useState<{ authority: DeviceAuthority; loading: boolean }>(() => ({
        authority: currentDeviceAuthority(),
        loading: Platform.OS === 'web' && connection.mode === 'hosted',
    }));

    React.useEffect(() => {
        if (Platform.OS !== 'web' || connection.mode === 'local') {
            setState({ authority: 'control', loading: false });
            return;
        }
        let cancelled = false;
        void listPairedGrants().then((grants) => {
            if (cancelled) return;
            setState({
                authority: grants.find((grant) => grant.machineId === connection.machineId)?.authority ?? 'observe',
                loading: false,
            });
        }).catch(() => {
            if (!cancelled) setState({ authority: 'observe', loading: false });
        });
        return () => { cancelled = true; };
    }, [connection.machineId, connection.mode, socketStatus]);

    return state;
}
