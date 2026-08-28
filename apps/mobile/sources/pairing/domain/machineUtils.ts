import type { Machine } from '@/sync/storageTypes';
import { PairedMachine } from './PairedMachine';

export function isMachineOnline(machine: Machine): boolean {
    return new PairedMachine({
        id: machine.id,
        active: machine.active,
        displayName: machine.metadata?.displayName,
        host: machine.metadata?.host,
    }).isOnline();
}
