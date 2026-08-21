import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateFile, writeJsonFileAtomic } from './persist.js';

const ENROLLMENT_TTL_MS = 5 * 60_000;
const MACHINE_TTL_MS = 365 * 24 * 60 * 60_000;
const hash = (value: string): string => createHash('sha256').update(value).digest('base64url');
const opaque = (prefix: string): string => `${prefix}_${randomBytes(24).toString('base64url')}`;

interface Enrollment { id: string; claimHash: string; relayUrl: string; webUrl?: string; createdAt: number; expiresAt: number; usedAt?: number }
interface Machine {
    credentialId: string;
    credentialHash: string;
    slug: string;
    signingPublicKey: string;
    name: string;
    createdAt: number;
    expiresAt: number;
    revokedAt?: number;
}
interface State { enrollments: Enrollment[]; machines: Machine[] }

export function enrolledMachineSlug(signingPublicKey: string): string {
    return `machine-${createHash('sha256').update('muxr-machine-v1\0').update(Buffer.from(signingPublicKey, 'base64')).digest('hex').slice(0, 32)}`;
}

export function enrollmentProofMessage(id: string, relayUrl: string, signingPublicKey: string): Buffer {
    return Buffer.from(`muxr-enroll-v1\n${id}\n${relayUrl}\n${signingPublicKey}`, 'utf8');
}

export class MachineAuthority {
    private readonly file: string;
    private state: State = { enrollments: [], machines: [] };
    private queue: Promise<void> = Promise.resolve();

    constructor(dataDir: string) { this.file = join(dataDir, 'machine-authority.json'); }

    private serialized<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.queue.then(operation);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async load(): Promise<void> {
        const raw = await readPrivateFile(this.file);
        if (raw === undefined) return;
        const parsed = JSON.parse(raw) as Partial<State>;
        if (!Array.isArray(parsed.enrollments) || !Array.isArray(parsed.machines)) throw new Error('invalid machine authority state');
        this.state = parsed as State;
    }

    private persist(): Promise<void> { return writeJsonFileAtomic(this.file, this.state); }

    createEnrollment(relayUrl: string, webUrl?: string, now = Date.now()): Promise<{ id: string; claim: string; expiresIn: number }> {
        return this.serialized(async () => {
            await this.load();
            this.state.enrollments = this.state.enrollments.filter((entry) => entry.expiresAt > now && entry.usedAt === undefined).slice(-99);
            const id = opaque('enroll');
            const claim = randomBytes(32).toString('base64url');
            this.state.enrollments.push({ id, claimHash: hash(claim), relayUrl, ...(webUrl === undefined ? {} : { webUrl }), createdAt: now, expiresAt: now + ENROLLMENT_TTL_MS });
            await this.persist();
            return { id, claim, expiresIn: ENROLLMENT_TTL_MS / 1000 };
        });
    }

    claimEnrollment(id: string, input: { claim: string; relayUrl: string; signingPublicKey: string; name: string }, now = Date.now()): Promise<
        | { state: 'issued'; credential: string; credentialId: string; slug: string; expiresAt: number; relayUrl: string; webUrl?: string }
        | { state: 'invalid_claim' | 'expired' | 'already_claimed' }
    > {
        return this.serialized(async () => {
            await this.load();
            const enrollment = this.state.enrollments.find((entry) => entry.id === id);
            if (enrollment === undefined || enrollment.claimHash !== hash(input.claim) || enrollment.relayUrl !== input.relayUrl) return { state: 'invalid_claim' };
            if (enrollment.expiresAt <= now) return { state: 'expired' };
            if (enrollment.usedAt !== undefined) return { state: 'already_claimed' };
            enrollment.usedAt = now;
            const slug = enrolledMachineSlug(input.signingPublicKey);
            const credential = opaque('muxr_mc');
            const credentialId = opaque('mc');
            const expiresAt = now + MACHINE_TTL_MS;
            const existing = this.state.machines.find((machine) => machine.slug === slug && machine.revokedAt === undefined);
            if (existing !== undefined) existing.revokedAt = now;
            this.state.machines.push({ credentialId, credentialHash: hash(credential), slug, signingPublicKey: input.signingPublicKey,
                name: input.name.slice(0, 120), createdAt: now, expiresAt });
            await this.persist();
            return { state: 'issued', credential, credentialId, slug, expiresAt, relayUrl: enrollment.relayUrl,
                ...(enrollment.webUrl === undefined ? {} : { webUrl: enrollment.webUrl }) };
        });
    }

    resolveCredential(credential: string, now = Date.now()): Promise<{ credentialId: string; slug: string; expiresAt: number } | undefined> {
        if (!credential.startsWith('muxr_mc_')) return Promise.resolve(undefined);
        return this.serialized(async () => {
            await this.load();
            const credentialHash = hash(credential);
            const machine = this.state.machines.find((entry) => entry.credentialHash === credentialHash
                && entry.revokedAt === undefined && entry.expiresAt > now);
            return machine === undefined ? undefined : { credentialId: machine.credentialId, slug: machine.slug, expiresAt: machine.expiresAt };
        });
    }

    isCredentialActive(credentialId: string, now = Date.now()): Promise<boolean> {
        return this.serialized(async () => {
            await this.load();
            return this.state.machines.some((machine) => machine.credentialId === credentialId
                && machine.revokedAt === undefined && machine.expiresAt > now);
        });
    }

    isMachineAllowed(slug: string, now = Date.now()): Promise<boolean> {
        return this.serialized(async () => {
            await this.load();
            const records = this.state.machines.filter((machine) => machine.slug === slug);
            return records.length === 0 || records.some((machine) => machine.revokedAt === undefined && machine.expiresAt > now);
        });
    }

    listMachines(): Promise<Array<{ slug: string; name: string; createdAt: number; expiresAt: number; expired: boolean; revoked: boolean }>> {
        return this.serialized(async () => {
            await this.load();
            const latest = new Map<string, Machine>();
            for (const machine of this.state.machines) latest.set(machine.slug, machine);
            return [...latest.values()].map(({ slug, name, createdAt, expiresAt, revokedAt }) => ({
                slug, name, createdAt, expiresAt, expired: expiresAt <= Date.now(), revoked: revokedAt !== undefined,
            }));
        });
    }

    revokeMachine(slug: string, now = Date.now()): Promise<{ credentialId: string } | undefined> {
        return this.serialized(async () => {
            await this.load();
            const records = this.state.machines.filter((entry) => entry.slug === slug);
            if (records.length === 0) return undefined;
            const machine = records.find((entry) => entry.revokedAt === undefined);
            if (machine !== undefined) {
                machine.revokedAt = now;
                await this.persist();
            }
            return { credentialId: (machine ?? records.at(-1)!).credentialId };
        });
    }
}
