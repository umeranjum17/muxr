/**
 * `approveLabOffer` serves the pairing socket the real host serves: line-delimited
 * JSON, one approval to answer, one device record back. A lab run that loses its
 * device callback or meets a line it cannot read must end the approval, not die
 * inside the socket handler where `linkHerdrLab`'s cleanup never runs.
 *
 * The host behind this socket is a stand-in because the real one only writes
 * well-formed lines: the unreadable line is the input under test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approveLabOffer } from './application/linkLabClient.mjs';

const servers = [];
const scratch = [];

/** A line server shaped like the host's pair.sock; `respond(line, write)` sees each line. */
function startPairingHost(respond) {
    const dir = mkdtempSync(join(tmpdir(), 'muxr-lab-approve-'));
    scratch.push(dir);
    const socketPath = join(dir, 'pair.sock');
    let closed;
    const sawClose = new Promise((resolve) => { closed = resolve; });
    const server = createServer((connection) => {
        let text = '';
        connection.on('data', (chunk) => {
            text += chunk.toString('utf8');
            const lines = text.split('\n');
            text = lines.pop() ?? '';
            for (const line of lines) {
                respond(line, {
                    send: (value) => connection.write(`${JSON.stringify(value)}\n`),
                    sendRaw: (raw) => connection.write(`${raw}\n`),
                });
            }
        });
        connection.on('close', closed);
    });
    servers.push(server);
    const listening = new Promise((resolve) => server.listen(socketPath, resolve));
    return { socketPath, listening, sawClose };
}

afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('approving a lab device from the pairing socket', () => {
    it('answers the approval once and hands over only the first offer', async () => {
        const host = startPairingHost((line, write) => {
            const event = JSON.parse(line);
            // The host offers, then asks for approval once a device claims the code;
            // it mints a fresh code right after it answers, and answers only a yes.
            if (event.intent) { write.send({ offer: { text: 'first-code' } }); write.send({ approval: { name: 'Lab device', words: ['am', 'be'] } }); }
            if (event.yes === true) { write.send({ offer: { text: 'refreshed-code' } }); write.send({ result: { name: 'Lab device', deviceId: 'dev_lab' } }); }
        });
        await host.listening;
        const offers = [];
        const approved = await approveLabOffer(host.socketPath, async (text) => { offers.push(text); }, Date.now() + 10_000);

        expect(approved).toEqual({ name: 'Lab device', deviceId: 'dev_lab' });
        expect(offers).toEqual(['first-code']);
        await host.sawClose;
    }, 20_000);

    it('ends the approval on a line it cannot read instead of dying in the handler', async () => {
        const host = startPairingHost((line, write) => {
            if (JSON.parse(line).intent) write.sendRaw('this line is not json');
        });
        await host.listening;
        let failure;
        try {
            await approveLabOffer(host.socketPath, () => undefined, Date.now() + 10_000);
        } catch (cause) {
            failure = cause;
        }

        // A rejection, not the 120 s timeout: the caller gets the socket back and its cleanup runs.
        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).not.toMatch(/timed out/);
        await host.sawClose;
    }, 20_000);
});
