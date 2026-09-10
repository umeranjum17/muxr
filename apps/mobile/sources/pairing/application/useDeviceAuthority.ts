import * as React from 'react';
import { Platform } from 'react-native';
import { useSocketStatus } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { isDemoTransport } from '@/demo/demoTransport';
import { currentDeviceAuthority, listPairedGrants } from './hostedE2ee';

export type DeviceAuthority = 'control' | 'observe';

export function useDeviceAuthority(): { authority: DeviceAuthority; loading: boolean } {
    const { status: socketStatus } = useSocketStatus();
    const connection = getCachedConnectionSettings();
    // Hooks run unconditionally: the demo screen stays mounted under pushed
    // session routes, so a pathname-dependent early return would change the
    // hook order between renders and crash. The demo branch resolves inside.
    const [state, setState] = React.useState<{ authority: DeviceAuthority; loading: boolean }>(() => {
        // The demo replay is owner-local and unpaired: control, never loading.
        // Authority still comes from grants everywhere else — display mode
        // alone never implies it.
        if (isDemoTransport()) return { authority: 'control', loading: false };
        return {
            authority: currentDeviceAuthority(),
            loading: Platform.OS === 'web' && connection.mode === 'hosted',
        };
    });

    React.useEffect(() => {
        if (isDemoTransport()) {
            setState({ authority: 'control', loading: false });
            return;
        }
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
