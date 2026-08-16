import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { secureEqual } from './auth.js';
import { readPrivateFile, writeJsonFileAtomic } from './persist.js';

export interface MachineRecord {
    machineId: string;
    name?: string;
    token: string;
    registeredAt: string;
}

export interface AccountRecord {
    accountId: string;
    token: string;
    createdAt: string;
    machines: Record<string, MachineRecord>;
}

interface RegistryFile {
    accounts: Record<string, AccountRecord>;
}

export interface MachineListEntry {
    machineId: string;
    name?: string;
    registeredAt: string;
    online: boolean;
}

function newToken(prefix: string): string {
    return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export class MachineRegistry {
    private readonly filePath: string;
    private data: RegistryFile = { accounts: {} };

    constructor(dataDir: string) {
        this.filePath = join(dataDir, 'registry.json');
    }

    async load(): Promise<void> {
        const raw = await readPrivateFile(this.filePath);
        if (raw !== undefined) this.data = JSON.parse(raw) as RegistryFile;
    }

    private async persist(): Promise<void> {
        await writeJsonFileAtomic(this.filePath, this.data);
    }

    async createAccount(): Promise<{ accountId: string; token: string }> {
        const accountId = newToken('acc');
        const token = newToken('acctok');
        this.data.accounts[accountId] = {
            accountId,
            token,
            createdAt: new Date().toISOString(),
            machines: {},
        };
        await this.persist();
        return { accountId, token };
    }

    findAccountByToken(token: string): AccountRecord | undefined {
        for (const account of Object.values(this.data.accounts)) {
            if (secureEqual(account.token, token)) return account;
        }
        return undefined;
    }

    resolveMachineToken(token: string): { machineId: string; accountId: string } | undefined {
        for (const account of Object.values(this.data.accounts)) {
            for (const machine of Object.values(account.machines)) {
                if (secureEqual(machine.token, token)) {
                    return { machineId: machine.machineId, accountId: account.accountId };
                }
            }
        }
        return undefined;
    }

    resolveClientMachines(token: string, machineIds: readonly string[]): { accountId: string } | undefined {
        const account = this.findAccountByToken(token);
        if (!account) return undefined;
        for (const machineId of machineIds) {
            if (!account.machines[machineId]) return undefined;
        }
        return { accountId: account.accountId };
    }

    async registerMachine(
        accountToken: string,
        input: { machineId?: string; name?: string },
    ): Promise<{ machineId: string; token: string } | undefined> {
        const account = this.findAccountByToken(accountToken);
        if (!account) return undefined;

        const machineId = input.machineId?.trim() || newToken('machine');
        if (account.machines[machineId]) return undefined;

        const token = newToken('machinetok');
        account.machines[machineId] = {
            machineId,
            ...(input.name === undefined ? {} : { name: input.name }),
            token,
            registeredAt: new Date().toISOString(),
        };
        await this.persist();
        return { machineId, token };
    }

    listMachines(accountToken: string, onlineIds: ReadonlySet<string>): MachineListEntry[] | undefined {
        const account = this.findAccountByToken(accountToken);
        if (!account) return undefined;

        return Object.values(account.machines).map((machine) => ({
            machineId: machine.machineId,
            ...(machine.name === undefined ? {} : { name: machine.name }),
            registeredAt: machine.registeredAt,
            online: onlineIds.has(machine.machineId),
        }));
    }

    registeredMachineCount(): number {
        let total = 0;
        for (const account of Object.values(this.data.accounts)) {
            total += Object.keys(account.machines).length;
        }
        return total;
    }
}
