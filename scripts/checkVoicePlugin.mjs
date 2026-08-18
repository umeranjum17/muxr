import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chunkAudio } from '../plugins/voice/stream.mjs';

const root = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'muxr-voice-plugin-'));
const rpc = join(root, 'plugins', 'voice', 'rpc.mjs');
const run = (method, input) => spawnSync(process.execPath, [rpc, method], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(input ?? null),
    env: { PATH: process.env.PATH, HOME: home, MUXR_HOME: home },
});

let result = run('status');
assert.equal(result.status, 0);
assert.deepEqual(JSON.parse(result.stdout), { configured: false, statusLabel: 'No key set' });
result = run('key.set', { key: 'xai-test-not-a-live-secret' });
assert.equal(result.status, 0, result.stderr);
assert.equal(statSync(join(home, 'xai.key')).mode & 0o077, 0);
assert.equal(readFileSync(join(home, 'xai.key'), 'utf8').trim(), 'xai-test-not-a-live-secret');
result = run('status');
assert.deepEqual(JSON.parse(result.stdout), { configured: true, statusLabel: 'Key set' });
result = run('key.clear');
assert.equal(result.status, 0, result.stderr);
result = run('status');
assert.deepEqual(JSON.parse(result.stdout), { configured: false, statusLabel: 'No key set' });
result = run('unknown');
assert.notEqual(result.status, 0);
const realtimeActions = readFileSync(join(root, 'apps/mobile/sources/realtime/realtimeActions.ts'), 'utf8');
assert.equal(realtimeActions.includes('Modal.prompt('), false, 'kernel must not collect provider secrets');
const voiceManifest = readFileSync(join(root, 'plugins/voice/muxr-ui.json'), 'utf8');
assert.match(voiceManifest, /"type":\s*"secure-prompt"/, 'provider secret must use attributed plugin prompt');
assert.match(voiceManifest, /"slot":\s*"host\.stream"/, 'voice provider must run behind a backend stream');
const oversizedAudio = 'A'.repeat(160 * 1024);
const audioChunks = chunkAudio(oversizedAudio);
assert.equal(audioChunks.join(''), oversizedAudio);
assert.ok(audioChunks.length > 1 && audioChunks.every((chunk) => chunk.length <= 96 * 1024 && chunk.length % 4 === 0), 'provider audio must fit public realtime frame bounds');
const mobileRealtime = readFileSync(join(root, 'apps/mobile/sources/voice/realtimeSession.ts'), 'utf8');
assert.doesNotMatch(mobileRealtime, /OpenAI|xAI|Grok|Gemini|api\.[a-z]+\.ai|gpt-|grok-/i, 'mobile realtime transport must stay provider-blind');
process.stdout.write('voice plugin rpc lifecycle passed\n');
