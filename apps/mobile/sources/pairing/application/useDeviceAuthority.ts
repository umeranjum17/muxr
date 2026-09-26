import * as React from 'react';
import { deviceAuthority, requiresStoredAuthority } from '../infrastructure/pairingPlatform';
import { useSocketStatus } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { currentDeviceAuthority, listPairedGrants } from './linkPairing';

export type DeviceAuthority = 'control' | 'observe';

export function useDeviceAuthority(): { authority: DeviceAuthority; loading: boolean } {
    const { status: socketStatus } = useSocketStatus();
    const connection = getCachedConnectionSettings();
    const [state, setState] = React.useState<{ authority: DeviceAuthority; loading: boolean }>(() => ({
        authority: currentDeviceAuthority(),
        loading: requiresStoredAuthority(),
    }));

    React.useEffect(() => {
        if (!requiresStoredAuthority()) {
            setState({ authority: deviceAuthority(connection.machineId, undefined), loading: false });
            return;
        }
        let cancelled = false;
        void listPairedGrants().then((grants) => {
            if (cancelled) return;
            setState({
                authority: deviceAuthority(connection.machineId, grants.find((grant) => grant.machineId === connection.machineId)),
                loading: false,
            });
        }).catch(() => {
            if (!cancelled) setState({ authority: deviceAuthority(connection.machineId, undefined), loading: false });
        });
        return () => { cancelled = true; };
    }, [connection.machineId, socketStatus]);

    return state;
}
