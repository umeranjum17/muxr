import * as React from 'react';
import { deviceAuthority, initialDeviceAuthority, loadDeviceAuthorityGrants } from '../infrastructure/pairingPlatform';
import { useSocketStatus } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';

export type DeviceAuthority = 'control' | 'observe';

export function useDeviceAuthority(): { authority: DeviceAuthority; loading: boolean } {
    const { status: socketStatus } = useSocketStatus();
    const connection = getCachedConnectionSettings();
    const [state, setState] = React.useState<{ authority: DeviceAuthority; loading: boolean }>(() => initialDeviceAuthority(connection.machineId));

    React.useEffect(() => {
        let cancelled = false;
        void loadDeviceAuthorityGrants().then((grants) => {
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
