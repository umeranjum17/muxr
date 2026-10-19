import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { validMachineCrypto } from '../domain/dist/index.js';
import { atomicWrite, error, flagValue, machineIdentity, print, randomBytes, relayPortFromEnv, stateDir } from '../infrastructure/runtime.mjs';
import { ensureHerdr } from '../infrastructure/herdr.mjs';
import { isTailnetIPv4, readSelfhostState, selfhostPath, writeSelfhostState } from '../infrastructure/selfhost.mjs';
import { resolveAdvertise } from '../infrastructure/selfhostRelay.mjs';

/** Prepare a foreground self-host without starting processes or managing ingress. */
export async function configureSelfHost(args) {
    try {
        if (!flagValue(args, '--advertise')?.trim()) throw new Error('--configure-only requires --advertise <ws:// or wss:// URL>');
        const port = Number(flagValue(args, '--port') ?? relayPortFromEnv() ?? 8792);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a TCP port (1-65535)');
        const advertise = await resolveAdvertise(args, port);
        const url = new URL(advertise.url);
        if (url.protocol !== 'ws:') throw new Error('--configure-only serves plain ws:// on the tailnet address; use --advertise ws://<name>:<port>');
        if (Number(url.port || 80) !== port) throw new Error('the ws:// advertise port must match --port (default 8792)');
        // --loopback: Tailscale Serve forwards the tailnet port to loopback (a BYOKit cloud computer), so there may be no tailnet address to bind.
        const loopback = args.includes('--loopback');
        if (loopback && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(url.hostname)) throw new Error('--loopback needs --advertise ws://<machine>.<tailnet>.ts.net:<port>');
        const bindHost = loopback ? '127.0.0.1' : isIP(url.hostname) ? url.hostname : (await lookup(url.hostname, { family: 4 })).address;
        if (!loopback && !isTailnetIPv4(bindHost)) throw new Error('--advertise must resolve to a Tailscale IPv4 address (100.64.0.0/10)');
        if (args.includes('--install-herdr')) await ensureHerdr({ dryRun: false, noInstall: false, installRequested: true });
        let state = readSelfhostState();
        if (existsSync(selfhostPath())) {
            const info = lstatSync(selfhostPath());
            if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('selfhost.json must be a regular owner-only file');
            if (!state?.machine?.id || !validMachineCrypto(state.machine.crypto, 'selfhost') || typeof state.mintSecret !== 'string' || !state.mintSecret) throw new Error('existing self-host state is invalid; refusing to replace its pairing identity');
            const sameConfiguration = state.relayUrl === advertise.url && state.relayPort === port
                && state.relayLocation === 'local' && state.relayRole === 'single-machine'
                && state.bindHost === bindHost && (state.tailscaleServe === true) === loopback && state.connectionMode === 'private' && !state.webEnabled && !state.ingress;
            if (!sameConfiguration) throw new Error('--configure-only cannot replace an existing connection; use `muxr setup` to reconfigure it');
        }
        const mintPath = join(stateDir(), 'relay', 'mint-secret');
        let secret;
        if (existsSync(mintPath)) {
            const info = lstatSync(mintPath);
            if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('relay mint-secret must be a regular owner-only file');
            try { secret = JSON.parse(readFileSync(mintPath, 'utf8')); }
            catch { throw new Error('relay mint-secret is invalid; refusing to replace its authority'); }
            if (typeof secret !== 'string' || !secret) throw new Error('relay mint-secret is invalid; refusing to replace its authority');
        } else {
            secret = state?.mintSecret ?? randomBytes(32).toString('base64url');
            if (typeof secret !== 'string' || !secret) throw new Error('existing self-host authority is invalid');
            atomicWrite(mintPath, `${JSON.stringify(secret)}\n`);
        }
        if (state && state.mintSecret !== secret) throw new Error('self-host and relay authority disagree; refusing to change either');
        if (!state) {
            state = { version: 1, machine: machineIdentity(undefined), relayPort: port,
                relayUrl: advertise.url, relayLocation: 'local', relayRole: 'single-machine',
                connectionMode: 'private', webEnabled: false, bindHost, ...(loopback ? { tailscaleServe: true } : {}), mintSecret: secret };
            writeSelfhostState(state);
        }
        print(`Configured ${advertise.url} (bind ${bindHost}:${port}, Tailscale ${loopback ? 'Serve' : 'only'}); no relay or service started.`);
        print('Start with `MUXR_MODE=selfhost muxr up`; once running, use `muxr pair` in another shell for the pairing offer.');
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
