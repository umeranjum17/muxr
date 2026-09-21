#!/usr/bin/env node
/**
 * CLI for the desktop host engine package.
 *
 * `path` and `capabilities` work without starting a session, so a consumer can
 * tell the user what is wrong before a desktop is opened rather than after.
 * Everything else is forwarded to the engine binary, so the CLI cannot drift
 * from the process protocol it documents.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Bridge } from '../dist/bridge.js';
import { EngineClient } from '../dist/engineProcess.js';
import { explainMissingEngine, resolveEngine } from '../dist/resolveEngine.js';

const [command, ...rest] = process.argv.slice(2);

async function main() {
    if (command === 'help' || command === '--help' || command === undefined) {
        console.log(`desklink-host

USAGE:
  desklink-host path                  print the engine binary this package would run
  desklink-host capabilities          print what this machine can do right now
  desklink-host bridge [--listen H:P] [--token T] [--source portal|x11] [--display :0]
                                      re-serve the engine's protocol over a WebSocket and
                                      print the URL to open; no signaling of your own needed
  desklink-host <engine command> ...  run the engine directly (serve, capture-probe, setup-input, version)

Set MUXR_DESKLINK_ENGINE to use an engine built somewhere else.`);
        return 0;
    }
    if (command === 'path') {
        const resolved = resolveEngine();
        if (resolved === null) {
            console.error(explainMissingEngine());
            return 1;
        }
        console.log(resolved.command);
        return 0;
    }
    if (command === 'bridge') {
        const resolved = resolveEngine();
        if (resolved === null) {
            console.error(explainMissingEngine());
            return 1;
        }
        const flag = (name, fallback) => {
            const index = rest.indexOf(`--${name}`);
            return index === -1 ? fallback : rest[index + 1];
        };
        const listen = flag('listen', '127.0.0.1:19400');
        const token = flag('token', randomBytes(24).toString('base64url'));
        const sourceKind = flag('source', process.env.MUXR_DESKTOP_SOURCE ?? 'portal');
        const display = flag('display', process.env.MUXR_DESKTOP_X11_DISPLAY);
        const bridge = await Bridge.start({
            listen,
            token,
            engineCommand: resolved.command,
            engineArgs: resolved.args,
            // The engine's own diagnostics are the only clue when a session
            // fails below the protocol, so they are forwarded rather than
            // swallowed.
            engineOptions: { onDiagnostic: (line) => console.error(`engine: ${line}`) },
            ...(sourceKind === 'x11'
                ? { source: display === undefined ? { kind: 'x11' } : { kind: 'x11', display } }
                : {}),
        });
        const host = listen.startsWith('0.0.0.0:') ? '<this machine>' : listen.split(':')[0];
        console.log(`engine   ${resolved.command}`);
        console.log(`bridge   ws://${listen}${'/desktop'}`);
        console.log(`token    ${token}`);
        console.log('');
        console.log(`open     http://${host}:${bridge.port}/?token=${encodeURIComponent(token)}`);
        console.log('');
        console.log('Open that URL in a browser on this machine, or point a phone at it.');
        console.log('ws:// is plaintext: keep it on a private network, or put it behind TLS.');
        const stop = async () => { await bridge.close(); process.exit(0); };
        process.on('SIGINT', () => void stop());
        process.on('SIGTERM', () => void stop());
        return await new Promise(() => undefined);
    }
    if (command === 'capabilities') {
        const resolved = resolveEngine();
        if (resolved === null) {
            console.error(explainMissingEngine());
            return 1;
        }
        const client = await EngineClient.start(resolved.command, resolved.args);
        try {
            console.log(JSON.stringify(await client.capabilities(), null, 2));
        } finally {
            await client.stop();
        }
        return 0;
    }
    const resolved = resolveEngine();
    if (resolved === null) {
        console.error(explainMissingEngine());
        return 1;
    }
    const child = spawn(resolved.command, [command, ...rest], { stdio: 'inherit' });
    return await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    },
);
