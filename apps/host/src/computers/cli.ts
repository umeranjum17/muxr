/**
 * `muxr computers add|ls`, lab only: no product path reaches it, and a real muxr home refuses it
 * the way it refuses `--fake` and `--herdr-core-lab`. The scratch home, the Core to talk to and
 * the ssh config come from the environment the lab sets up.
 */
import { createInterface } from 'node:readline/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { ComputerJoinError } from './domain/computerWords.js';
import { joinComputer } from './application/joinComputer.js';
import { listComputers, watchComputers } from './application/listComputers.js';
import { createHcMachines } from './infrastructure/hcMachines.js';
import { sshPaths } from './infrastructure/sshTools.js';

function assertLab(env: NodeJS.ProcessEnv): string {
    const home = env.MUXR_HOME;
    let ownerDefault: string | undefined;
    try { ownerDefault = resolve(join(userInfo().homedir, '.muxr')); } catch { /* no passwd entry: cannot prove the home is safe */ }
    if (env.MUXR_COMPUTERS_LAB !== '1' || home === undefined || ownerDefault === undefined || resolve(home) === ownerDefault) {
        throw new Error('muxr computers is a lab command for now: set MUXR_COMPUTERS_LAB=1 and MUXR_HOME to a test folder');
    }
    return home;
}

const option = (args: string[], flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args[at + 1];
};

export async function computersCli(args: string[], env: NodeJS.ProcessEnv = process.env, out: (line: string) => void = console.log): Promise<number> {
    const home = assertLab(env);
    const paths = sshPaths(home, env.MUXR_COMPUTERS_USER_SSH_CONFIG ?? join(homedir(), '.ssh', 'config'));
    const hc = createHcMachines(env.MUXR_HC_BIN ?? 'hc', env);
    const [verb, ...rest] = args;
    if (verb === 'ls') {
        if (rest.includes('--watch')) {
            watchComputers(hc, (row) => out(`${row.name}\t${row.state}\t${row.version ?? ''}`));
            return new Promise<number>(() => undefined);
        }
        const { joined, known } = await listComputers({ paths, hc });
        for (const row of joined) out(`${row.name}\t${row.state}\t${row.version ?? ''}`);
        for (const name of known) out(`${name}\tknown, not joined`);
        return 0;
    }
    const target = rest[0];
    if (verb !== 'add' || target === undefined) {
        out('usage: muxr computers add <ssh-name | user@address[:port]> [--name <name>] [--fingerprint <SHA256:...>]\n       muxr computers ls [--watch]');
        return 2;
    }
    const request = { target, name: option(rest, '--name'), fingerprint: option(rest, '--fingerprint') };
    const deps = { paths, hc, keyFrom: env.MUXR_COMPUTERS_KEY_FROM };
    try {
        const joined = await joinComputer(deps, request).catch(async (error: unknown) => {
            // A new host key at a terminal is one confirm away: show it, ask, join again.
            if (!(error instanceof ComputerJoinError) || error.kind !== 'unknown-host-key' || !process.stdin.isTTY) throw error;
            const fingerprint = /(SHA256:\S+)/.exec(error.message)?.[1];
            const ask = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await ask.question(`${error.message}\nTrust it? [y/N] `);
            ask.close();
            if (!/^y/i.test(answer) || fingerprint === undefined) throw new Error('not trusted; nothing was changed');
            return joinComputer(deps, { ...request, fingerprint });
        });
        out(`joined ${joined.name} (${joined.address}, ${joined.fingerprint}): ${joined.state}, Herdr Core ${joined.version}`);
        if (joined.updatedFrom !== undefined) out(`updated Herdr Core on ${joined.name} from ${joined.updatedFrom} to ${joined.version}`);
        if (joined.warning !== undefined) out(joined.warning);
        return 0;
    } catch (error) {
        out(error instanceof Error ? error.message : String(error));
        return 1;
    }
}

