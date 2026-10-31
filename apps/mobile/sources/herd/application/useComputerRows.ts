import * as React from 'react';
import { getCachedConnectionSettings } from '@/connection';
import { listPairedGrants, type StoredHostedGrant } from '@/pairing/e2ee';
import { openPairedMachine, SshComputerNeedsActivation } from '@/collaboration';
import { useAllMachines, useSession, useSocketStatus } from '@/catalog/store';
import type { ComputerRow } from '../presentation/ComputersSheet';

type Probe = { online: boolean; reason?: string; ssh?: boolean };

/**
 * The picker rows for sending an agent to another computer, built on the
 * pairings the app already keeps. Each other computer is checked on a link of
 * its own; `check` answers why it cannot take this agent, or nothing when it can.
 * A computer reached only by switching to it (SSH, a loopback relay) is checked
 * when picked: `switchable` lets such a row through, otherwise it says why not.
 */
export function useComputerRows(o: {
    visible: boolean;
    sessionId: string;
    check: (client: Awaited<ReturnType<typeof openPairedMachine>>) => Promise<string | undefined>;
    switchable: boolean;
}): { rows: ComputerRow[]; failure: string | undefined; sourceName: string } {
    const { visible, sessionId, check, switchable } = o;
    const session = useSession(sessionId);
    const machines = useAllMachines({ includeOffline: true });
    const socket = useSocketStatus();
    const [grants, setGrants] = React.useState<StoredHostedGrant[]>([]);
    const [probes, setProbes] = React.useState<Record<string, Probe>>({});
    const [failure, setFailure] = React.useState<string>();
    const sourceMachineId = getCachedConnectionSettings().machineId;
    const checkRef = React.useRef(check);
    checkRef.current = check;

    React.useEffect(() => {
        if (!visible) return;
        let live = true;
        setProbes({});
        setFailure(undefined);
        void listPairedGrants().then((paired) => {
            if (!live) return;
            setGrants(paired);
            for (const grant of paired) {
                if (grant.machineId === sourceMachineId) {
                    setProbes((value) => ({ ...value, [grant.machineId]: { online: true } }));
                    continue;
                }
                void (async () => {
                    try {
                        const client = await openPairedMachine(grant);
                        try {
                            const reason = await checkRef.current(client);
                            if (live) setProbes((value) => ({ ...value, [grant.machineId]: { online: true, ...(reason === undefined ? {} : { reason }) } }));
                        } finally { client.close(); }
                    } catch (cause) {
                        if (live) setProbes((value) => ({ ...value, [grant.machineId]: { online: false, ssh: cause instanceof SshComputerNeedsActivation } }));
                    }
                })();
            }
        }).catch((cause: unknown) => { if (live) setFailure(cause instanceof Error ? cause.message : String(cause)); });
        return () => { live = false; };
    }, [visible, sourceMachineId]);

    const displayName = (grant: StoredHostedGrant) => machines.find((machine) => machine.id === grant.machineId)?.metadata?.displayName?.trim()
        || grant.machineName?.trim() || 'Paired computer';
    const rows = React.useMemo<ComputerRow[]>(() => grants.map((grant) => {
        const probe = probes[grant.machineId];
        const active = grant.machineId === sourceMachineId;
        const isOnline = active ? socket.status === 'connected' : probe?.online === true;
        let state: ComputerRow['state'] = isOnline ? 'online' : 'offline';
        if (!isOnline && active) state = 'asleep';
        else if (!active && probe?.ssh) state = 'ssh';
        let disabledReason: string | undefined;
        if (probe?.ssh && !switchable) disabledReason = 'Switch to it in Computers first.';
        else if (probe?.online) disabledReason = probe.reason;
        return {
            id: grant.machineId,
            name: active ? 'This computer' : displayName(grant),
            state,
            inUse: active || session?.metadata?.machineId === grant.machineId,
            checking: !active && probe === undefined,
            grant,
            disabledReason,
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [grants, machines, probes, session?.metadata?.machineId, socket.status, sourceMachineId, switchable]);

    const sourceName = machines.find((machine) => machine.id === sourceMachineId)?.metadata?.displayName?.trim() || 'the previous computer';
    return { rows, failure, sourceName };
}
