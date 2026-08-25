import * as React from 'react';
import { Platform } from 'react-native';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { currentDeviceAuthority, loadHostedGrant } from '@/state/hostedE2ee';
import { useSocketStatus } from '@/sync/storage';

export type DeviceAuthority = 'control' | 'observe';

/** Reactive, fail-closed authority for every control-producing mobile surface. */
export function useDeviceAuthority(): { authority: DeviceAuthority; loading: boolean } {
    const { status: socketStatus } = useSocketStatus();
    const connection = getCachedConnectionSettings();
    const [state, setState] = React.useState<{ authority: DeviceAuthority; loading: boolean }>(() => {
        const authority = currentDeviceAuthority();
        return {
            authority,
            loading: Platform.OS === 'web' && connection.mode === 'hosted' && authority !== 'control',
        };
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web') {
            setState({ authority: 'control', loading: false });
            return;
        }
        if (connection.mode === 'local') {
            setState({ authority: 'observe', loading: false });
            return;
        }
        let cancelled = false;
        void loadHostedGrant(connection.machineId).then((grant) => {
            if (!cancelled) setState({ authority: grant?.authority ?? 'observe', loading: false });
        });
        return () => { cancelled = true; };
    }, [connection.machineId, connection.mode, socketStatus]);

    return state;
}
