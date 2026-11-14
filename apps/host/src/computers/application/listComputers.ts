/** The computers muxr knows: the ones joined through Herdr Core, then the ssh config names it could offer. */
import { readFileSync, existsSync } from 'node:fs';
import { stateWord } from '../domain/computerWords.js';
import { knownSshHosts } from '../domain/sshEntries.js';
import type { HcMachines } from '../infrastructure/hcMachines.js';
import type { SshPaths } from '../infrastructure/sshTools.js';

export interface ComputerRow {
    name: string;
    state: string;
    version?: string;
}

export async function listComputers(deps: { paths: SshPaths; hc: HcMachines }): Promise<{ joined: ComputerRow[]; known: string[] }> {
    const machines = await deps.hc.list();
    const joined = machines.map((machine) => ({ name: machine.name, state: stateWord(machine.state), version: machine.version }));
    const config = existsSync(deps.paths.userConfig) ? readFileSync(deps.paths.userConfig, 'utf8') : '';
    const taken = new Set(machines.map((machine) => machine.name));
    return { joined, known: knownSshHosts(config).filter((name) => !taken.has(name)) };
}

/** Herdr Core has no machine event, so a computer's link is polled; `onChange` hears each state change. */
export function watchComputers(hc: HcMachines, onChange: (row: ComputerRow) => void, intervalMs = 5_000): () => void {
    const last = new Map<string, string>();
    const poll = async (): Promise<void> => {
        for (const machine of await hc.list().catch(() => [])) {
            const state = stateWord(machine.state);
            if (last.get(machine.name) === state) continue;
            last.set(machine.name, state);
            onChange({ name: machine.name, state, version: machine.version });
        }
    };
    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => clearInterval(timer);
}
