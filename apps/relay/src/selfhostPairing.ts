import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateFile, writeJsonFileAtomic } from './persist.js';

/**
 * File-backed self-host pairing store: pair sessions (CLI <-> phone rendezvous)
 * and device credentials (what a paired phone presents to mint WS tickets).
 * The self-host analog of the cloud pairSessions/credentials collections.
 */

const PAIR_TTL_MS = 2 * 60_000;
const MAX_SESSIONS = 100;

export interface SelfhostPairSession {
    pairId: string;
    claimHash: string;
    machineSlug: string;
    deviceKind: 'native' | 'browser';
    authority?: 'control' | 'observe';
    createdAt: number;
    expiresAt: number;
    usedAt?: number;
    deviceId?: string;
    devicePublicKey?: string;
    deviceName?: string;
    mailbox?: string;
    grant?: string;
    grantFetchedAt?: number;
    acknowledgedAt?: number;
    codeHash?: string;
    codePayload?: string;
    codeExpiresAt?: number;
}

export interface SelfhostDevice {
    deviceId: string;
    credentialHash: string;
    publicKey: string;
    name: string;
    machineSlug: string;
    createdAt: number;
    expiresAt?: number;
    authority?: 'control' | 'observe';
    currentGrant?: string;
    keyVersion?: number;
    revokedAt?: number;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('base64url');
const opaque = (prefix: string): string => `${prefix}_${randomBytes(18).toString('base64url')}`;

interface State {
    sessions: SelfhostPairSession[];
    devices: SelfhostDevice[];
}

export class SelfhostPairing {
    private readonly file: string;
    private state: State = { sessions: [], devices: [] };
    private queue: Promise<void> = Promise.resolve();

    constructor(dataDir: string) {
        this.file = join(dataDir, 'selfhost-pairing.json');
        const sweep = setInterval(() => { void this.sweepExpired().catch(() => undefined); }, 30_000);
        sweep.unref();
    }

    private serialized<T>(op: () => Promise<T>): Promise<T> {
        const run = this.queue.then(op);
        this.queue = run.then(() => undefined, () => undefined);
        return run;
    }

    private parse(raw: string): State {
        const parsed = JSON.parse(raw) as Partial<State>;
        if (!Array.isArray(parsed.sessions) || !Array.isArray(parsed.devices)) throw new Error('invalid pairing state shape');
        return parsed as State;
    }

    private async load(): Promise<void> {
        const raw = await readPrivateFile(this.file);
        if (raw === undefined) return;
        try {
            this.state = this.parse(raw);
        } catch (cause) {
            const backup = await readPrivateFile(`${this.file}.bak`);
            const note = backup === undefined
                ? 'no backup exists'
                : 'a backup exists for forensic recovery only; restoring it can resurrect revoked credentials';
            // Never auto-restore authorization state: a pre-revocation backup
            // could resurrect a credential. Fail closed until the owner repairs it.
            throw new Error(`self-host pairing state is corrupt; ${note}`, { cause });
        }
    }

    private async persist(): Promise<void> {
        const previous = await readPrivateFile(this.file);
        if (previous !== undefined) {
            const backup = this.parse(previous);
            // Pairing handoffs are deliberately ephemeral. A forensic backup may
            // retain device authorization history, never consumed codes/sessions.
            backup.sessions = [];
            await writeJsonFileAtomic(`${this.file}.bak`, backup);
        }
        await writeJsonFileAtomic(this.file, this.state);
    }

    private sweepExpired(now = Date.now()): Promise<void> {
        return this.serialized(async () => {
            await this.load();
            const before = this.state.sessions.length;
            this.state.sessions = this.state.sessions.filter((session) => session.usedAt !== undefined || session.expiresAt > now);
            if (this.state.sessions.length !== before) await this.persist();
        });
    }

    /** CLI side (owner/machine authed at the route): open a two-minute pairing window. */
    createSession(input: { claim: string; machineSlug: string; deviceKind: 'native' | 'browser'; authority?: 'control' | 'observe' }, now = Date.now()): Promise<{ pairId: string; expiresIn: number }> {
        return this.serialized(async () => {
            await this.load();
            this.state.sessions = this.state.sessions
                .filter((session) => session.expiresAt > now || (session.usedAt !== undefined && session.grant === undefined))
                .slice(-MAX_SESSIONS);
            const pairId = opaque('pair');
            this.state.sessions.push({
                pairId,
                claimHash: hash(input.claim),
                machineSlug: input.machineSlug,
                deviceKind: input.deviceKind,
                authority: input.deviceKind === 'browser' ? input.authority ?? 'control' : 'control',
                createdAt: now,
                expiresAt: now + PAIR_TTL_MS,
            });
            await this.persist();
            return { pairId, expiresIn: PAIR_TTL_MS / 1000 };
        });
    }

    publishCode(pairId: string, machineSlug: string | undefined, input: { codeHash: string; payload: string }, now = Date.now()): Promise<boolean> {
        return this.serialized(async () => {
            await this.load();
            const session = this.state.sessions.find((entry) => entry.pairId === pairId);
            if (session === undefined || machineSlug !== undefined && session.machineSlug !== machineSlug
                || session.expiresAt <= now || session.usedAt !== undefined || input.codeHash.length !== 43
                || input.payload.length === 0 || input.payload.length > 16 * 1024) return false;
            session.codeHash = input.codeHash;
            session.codePayload = input.payload;
            session.codeExpiresAt = session.expiresAt;
            await this.persist();
            return true;
        });
    }

    /** Phone side: consume the encrypted lookup before claiming the underlying session. */
    resolveCode(codeHash: string, now = Date.now()): Promise<{ state: 'resolved'; payload: string } | { state: 'invalid' | 'expired' }> {
        return this.serialized(async () => {
            await this.load();
            const session = this.state.sessions.find((entry) => entry.codeHash === codeHash);
            if (session === undefined || session.codePayload === undefined) return { state: 'invalid' };
            if ((session.codeExpiresAt ?? session.expiresAt) <= now) {
                this.state.sessions = this.state.sessions.filter((entry) => entry !== session);
                await this.persist();
                return { state: 'expired' };
            }
            const payload = session.codePayload;
            delete session.codeHash;
            delete session.codePayload;
            delete session.codeExpiresAt;
            await this.persist();
            return { state: 'resolved', payload };
        });
    }

    sessionMachineSlug(pairId: string): Promise<string | undefined> {
        return this.serialized(async () => {
            await this.load();
            return this.state.sessions.find((session) => session.pairId === pairId)?.machineSlug;
        });
    }

    /** Phone side: single-use claim. Returns the device credential on success. */
    claim(
        pairId: string,
        input: { claim: string; devicePublicKey: string; deviceName: string; deviceKind: 'native' | 'browser'; mailbox: string; expiresAt?: number },
        now = Date.now(),
    ): Promise<{ state: 'issued'; deviceId: string; credential: string } | { state: 'already_claimed' | 'expired' | 'invalid_claim' | 'wrong_device_kind' }> {
        return this.serialized(async () => {
            await this.load();
            const session = this.state.sessions.find((s) => s.pairId === pairId);
            if (session === undefined || session.claimHash !== hash(input.claim)) return { state: 'invalid_claim' };
            if (session.expiresAt <= now) {
                this.state.sessions = this.state.sessions.filter((entry) => entry !== session);
                await this.persist();
                return { state: 'expired' };
            }
            if ((session.deviceKind ?? 'native') !== input.deviceKind) return { state: 'wrong_device_kind' };
            if (session.usedAt !== undefined) return { state: 'already_claimed' };
            session.usedAt = now;
            session.devicePublicKey = input.devicePublicKey;
            session.deviceName = input.deviceName;
            session.mailbox = input.mailbox;
            const deviceId = opaque('dev');
            const credential = opaque('muxr_dc');
            session.deviceId = deviceId;
            this.state.devices.push({
                deviceId,
                credentialHash: hash(credential),
                publicKey: input.devicePublicKey,
                name: input.deviceName,
                machineSlug: session.machineSlug,
                createdAt: now,
                ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
                authority: session.authority ?? (session.deviceKind === 'browser' ? 'observe' : 'control'),
            });
            await this.persist();
            return { state: 'issued', deviceId, credential };
        });
    }

    /** CLI polls for the phone's mailbox. */
    poll(pairId: string, machineSlug: string | undefined, now = Date.now()): Promise<{ state: 'pending' | 'expired' | 'claimed'; mailbox?: string; deviceId?: string; devicePublicKey?: string; authority?: 'control' | 'observe'; grantPresent?: boolean; acknowledged?: boolean }> {
        return this.serialized(async () => {
            await this.load();
            const session = this.state.sessions.find((s) => s.pairId === pairId);
            if (session === undefined || machineSlug !== undefined && session.machineSlug !== machineSlug) return { state: 'expired' };
            if (session.usedAt === undefined && session.expiresAt <= now) {
                this.state.sessions = this.state.sessions.filter((entry) => entry !== session);
                await this.persist();
                return { state: 'expired' };
            }
            if (session.usedAt === undefined) return { state: 'pending' };
            const result: { state: 'claimed'; mailbox?: string; deviceId?: string; devicePublicKey?: string; authority?: 'control' | 'observe'; grantPresent?: boolean; acknowledged?: boolean } = { state: 'claimed' };
            if (session.mailbox !== undefined) result.mailbox = session.mailbox;
            if (session.deviceId !== undefined) result.deviceId = session.deviceId;
            if (session.devicePublicKey !== undefined) result.devicePublicKey = session.devicePublicKey;
            result.authority = session.authority ?? (session.deviceKind === 'browser' ? 'observe' : 'control');
            result.grantPresent = session.grant !== undefined;
            result.acknowledged = session.acknowledgedAt !== undefined;
            return result;
        });
    }

    /** CLI uploads the authenticated machine grant after decrypting the mailbox. */
    uploadGrant(pairId: string, machineSlug: string | undefined, grant: string, now = Date.now()): Promise<boolean> {
        return this.serialized(async () => {
            await this.load();
            const session = this.state.sessions.find((s) => s.pairId === pairId);
            if (session === undefined || machineSlug !== undefined && session.machineSlug !== machineSlug || session.usedAt === undefined) return false;
            const device = this.state.devices.find((entry) => entry.deviceId === session.deviceId && entry.revokedAt === undefined);
            if (device === undefined) return false;
            session.grant = grant;
            device.currentGrant = grant;
            await this.persist();
            return true;
        });
    }

    /** Browser grants remain recoverable until durable acknowledgement; native clients complete on fetch. */
    fetchGrant(pairId: string, deviceId: string, now = Date.now()): Promise<string | undefined> {
        return this.serialized(async () => {
            await this.load();
            const session = this.state.sessions.find((s) => s.pairId === pairId);
            if (session === undefined || session.deviceId !== deviceId || session.grant === undefined) return undefined;
            const grant = session.grant;
            if (session.deviceKind === 'native') this.state.sessions = this.state.sessions.filter((entry) => entry !== session);
            else session.grantFetchedAt = now;
            await this.persist();
            return grant;
        });
    }

    acknowledgeGrant(pairId: string, deviceId: string, now = Date.now()): Promise<boolean> {
        return this.serialized(async () => {
            await this.load();
            const session = this.state.sessions.find((entry) => entry.pairId === pairId && entry.deviceId === deviceId && entry.grantFetchedAt !== undefined);
            if (session === undefined) return false;
            session.acknowledgedAt = now;
            await this.persist();
            return true;
        });
    }

    /** Resolve a device credential to its device id + bound machine (for ticket minting). */
    resolveDeviceCredential(credential: string): Promise<{ deviceId: string; machineSlug: string } | undefined> {
        if (!credential.startsWith('muxr_dc_')) return Promise.resolve(undefined);
        return this.serialized(async () => {
            await this.load();
            const credentialHash = hash(credential);
            const device = this.state.devices.find((d) => d.credentialHash === credentialHash && d.revokedAt === undefined
                && (d.expiresAt === undefined || d.expiresAt > Date.now()));
            return device === undefined ? undefined : { deviceId: device.deviceId, machineSlug: device.machineSlug };
        });
    }

    listDevices(machineSlug: string): Promise<Array<{ deviceId: string; name: string; publicKey: string; createdAt: number }>> {
        return this.serialized(async () => {
            await this.load();
            return this.state.devices
                .filter((device) => device.machineSlug === machineSlug && device.revokedAt === undefined)
                .map(({ deviceId, name, publicKey, createdAt }) => ({ deviceId, name, publicKey, createdAt }));
        });
    }

    isDeviceActive(deviceId: string): Promise<boolean> {
        return this.serialized(async () => {
            await this.load();
            return this.state.devices.some((device) => device.deviceId === deviceId && device.revokedAt === undefined
                && (device.expiresAt === undefined || device.expiresAt > Date.now()));
        });
    }

    fetchCurrentGrant(deviceId: string, machineSlug: string): Promise<string | undefined> {
        return this.serialized(async () => {
            await this.load();
            return this.state.devices.find((device) => device.deviceId === deviceId
                && device.machineSlug === machineSlug && device.revokedAt === undefined)?.currentGrant;
        });
    }

    storeCurrentGrants(machineSlug: string, keyVersion: number, grants: Array<{ deviceId: string; grant: string }>): Promise<boolean> {
        return this.serialized(async () => {
            await this.load();
            const active = this.state.devices.filter((device) => device.machineSlug === machineSlug && device.revokedAt === undefined);
            const supplied = new Map(grants.map((entry) => [entry.deviceId, entry.grant]));
            const currentVersion = Math.max(0, ...active.map((device) => device.keyVersion ?? 0));
            if (!Number.isInteger(keyVersion) || keyVersion < currentVersion || keyVersion < 1
                || supplied.size !== grants.length || supplied.size !== active.length
                || active.some((device) => !supplied.has(device.deviceId))) return false;
            for (const device of active) {
                device.currentGrant = supplied.get(device.deviceId)!;
                device.keyVersion = keyVersion;
            }
            await this.persist();
            return true;
        });
    }

    /** Revoke a paired device: credential dies immediately, grants stop being served. */
    revokeDevice(deviceId: string, machineSlug?: string): Promise<{ machineSlug: string } | undefined> {
        return this.serialized(async () => {
            await this.load();
            const device = this.state.devices.find((d) => d.deviceId === deviceId && (machineSlug === undefined || d.machineSlug === machineSlug) && d.revokedAt === undefined);
            if (device === undefined) return undefined;
            device.revokedAt = Date.now();
            delete device.currentGrant;
            for (const session of this.state.sessions) {
                if (session.deviceId === deviceId) delete session.grant;
            }
            await this.persist();
            return { machineSlug: device.machineSlug };
        });
    }
}
