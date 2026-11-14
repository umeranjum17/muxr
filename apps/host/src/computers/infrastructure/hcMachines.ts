/** Herdr Core's machine verbs, through its `hc` command line (the API has no install switch). */
import { classifyCoreError } from '../domain/computerWords.js';
import { run } from './run.js';

export interface CoreMachine {
    id: string;
    name: string;
    target: string;
    version: string;
    state: string;
    /** Herdr Core's own report that agents survive a logout; absent on a Core that does not say. */
    keepsRunningAfterLogout?: boolean;
}

export interface HcMachines {
    add(name: string, target: string): Promise<CoreMachine>;
    update(name: string): Promise<void>;
    list(): Promise<CoreMachine[]>;
}

interface RawMachine { id: string; name: string; target: string; version: string; state?: string; keeps_running_after_logout?: boolean | null }

const toMachine = (raw: RawMachine): CoreMachine => ({
    id: raw.id,
    name: raw.name,
    target: raw.target,
    version: raw.version,
    state: raw.state ?? 'connecting',
    ...(typeof raw.keeps_running_after_logout === 'boolean' ? { keepsRunningAfterLogout: raw.keeps_running_after_logout } : {}),
});

/** `env` names the Core to talk to (its session and private dirs); `bin` is its `hc`. */
export function createHcMachines(bin: string, env: NodeJS.ProcessEnv): HcMachines {
    const hc = async (name: string, args: string[]): Promise<unknown> => {
        const out = await run(bin, [...args, '--json'], { env, timeoutMs: 120_000 });
        if (out.code === 0) return JSON.parse(out.stdout);
        let message = (out.stderr || out.stdout).trim();
        try { message = (JSON.parse(out.stdout) as { error: { message: string } }).error.message; } catch { /* plain text */ }
        throw classifyCoreError(name, message);
    };
    const list = async (): Promise<CoreMachine[]> => ((await hc('machines', ['machine', 'ls'])) as { machines: RawMachine[] }).machines.map(toMachine);
    return {
        list,
        async add(name, target) {
            // --install puts a Core on a computer that has none; it does not update an older one.
            const added = (await hc(name, ['machine', 'add', target, '--name', name, '--install'])) as RawMachine;
            return toMachine(added);
        },
        async update(name) {
            await hc(name, ['machine', 'update', name]);
        },
    };
}
