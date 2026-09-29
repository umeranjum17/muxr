import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { countTerminalFrames } from './terminalFrames.mjs';

test('terminal byte stream counts complete frames across chunk boundaries', async () => {
    let frames = 0;
    const consume = countTerminalFrames(() => { frames += 1; });
    const first = Buffer.from(JSON.stringify({ type: 'terminal.frame', bytes: '8J+YgA==' }) + '\n');
    const other = Buffer.from(JSON.stringify({ type: 'result', message: 'terminal.frame' }) + '\n');
    const second = Buffer.from(JSON.stringify({ type: 'terminal.frame', bytes: 'Yg==' }) + '\n');
    for await (const chunk of Readable.from([
        first.subarray(0, 20),
        first.subarray(20, 25),
        Buffer.concat([first.subarray(25), other, second.subarray(0, 15)]),
        second.subarray(15),
    ])) consume(chunk);
    assert.equal(frames, 2);
});
