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
import { EngineClient } from '../dist/engineProcess.js';
import { explainMissingEngine, resolveEngine } from '../dist/resolveEngine.js';

const [command, ...rest] = process.argv.slice(2);

async function main() {
    if (command === 'help' || command === '--help' || command === undefined) {
        console.log(`desklink-host

USAGE:
  desklink-host path                  print the engine binary this package would run
  desklink-host capabilities          print what this machine can do right now
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
