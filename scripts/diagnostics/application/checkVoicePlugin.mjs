/**
 * Voice provider policy stays on the host. This check drives the real
 * pieces: `muxr voice` (the only place a provider is chosen or a key set),
 * the voice plugin's `status` RPC (what clients see) and the manifest (what
 * clients can invoke), and asserts the client vocabulary stays generic.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chunkAudio } from '../../../plugins/voice/providers/xai.mjs';

const root = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'muxr-voice-plugin-'));
const rpc = join(root, 'plugins', 'voice', 'rpc.mjs');
const cli = join(root, 'scripts', 'cli.mjs');
const env = { PATH: process.env.PATH, HOME: home, MUXR_HOME: home };
const rpcCall = (method, input) => spawnSync(process.execPath, [rpc, method], {
    cwd: root, encoding: 'utf8', input: JSON.stringify(input ?? null),
    env: { ...env, MUXR_PLUGIN_STATE_DIR: join(home, 'plugin-state', 'muxr.voice') },
});
const voice = (args, input) => spawnSync(process.execPath, [cli, 'voice', ...args], { cwd: root, encoding: 'utf8', input, env: { ...env, MUXR_NO_SERVICE_COMMANDS: '1' } });
const status = () => { const result = rpcCall('status'); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
const generic = (value) => assert.doesNotMatch(JSON.stringify(value), /xai|grok|gemini|openai|codex|key|token|account|model/i, 'client-visible voice status must stay provider-neutral');

// Fresh host: Codex is the default adapter; the client only learns readiness.
const fresh = JSON.parse(voice(['status', '--json']).stdout);
assert.equal(fresh.selected, 'codex', 'fresh voice configuration defaults to Codex');
assert.deepEqual(Object.keys(status()).sort(), ['configured', 'statusLabel']);
generic(status());

// Selecting an API-key adapter and setting its key happens only through the host CLI.
assert.equal(voice(['select', 'xai']).status, 0);
assert.equal(JSON.parse(voice(['status', '--json']).stdout).selected, 'xai', 'explicit selection survives another invocation');
assert.notEqual(voice(['select', 'unknown']).status, 0);
assert.equal(JSON.parse(voice(['status', '--json']).stdout).selected, 'xai', 'failed switch retains selection');
assert.deepEqual(status(), { configured: false, statusLabel: 'Not configured on this computer' });
const set = voice(['key', 'set', '--stdin'], 'xai-test-not-a-live-secret\n');
assert.equal(set.status, 0, set.stderr);
assert.equal(statSync(join(home, 'xai.key')).mode & 0o077, 0);
assert.equal(readFileSync(join(home, 'xai.key'), 'utf8').trim(), 'xai-test-not-a-live-secret');
assert.doesNotMatch(`${set.stdout}${voice(['status']).stdout}${voice(['status', '--json']).stdout}`, /not-a-live-secret/, 'the key must never be printed');
assert.deepEqual(status(), { configured: true, statusLabel: 'Ready' });
assert.equal(voice(['key', 'clear']).status, 0);
assert.deepEqual(status(), { configured: false, statusLabel: 'Not configured on this computer' });
// A symlinked state root never receives a key.
const symlinkTarget = join(home, 'symlink-target');
const symlinkRoot = join(home, 'symlink-root');
mkdirSync(symlinkTarget);
symlinkSync(symlinkTarget, symlinkRoot, 'dir');
const symlinkWrite = spawnSync(process.execPath, [cli, 'voice', 'key', 'set', '--stdin'], { cwd: root, encoding: 'utf8', input: 'must-not-write\n', env: { ...env, MUXR_HOME: symlinkRoot, MUXR_NO_SERVICE_COMMANDS: '1' } });
assert.notEqual(symlinkWrite.status, 0, 'provider key write followed a symlinked MUXR_HOME');
assert.equal(existsSync(join(symlinkTarget, 'xai.key')), false);
assert.equal(voice(['select', 'codex']).status, 0);
assert.notEqual(rpcCall('unknown').status, 0);
assert.notEqual(rpcCall('key.set', { key: 'x' }).status, 0, 'the plugin RPC must not accept keys from clients');
assert.notEqual(rpcCall('provider.set', { providerId: 'xai' }).status, 0, 'the plugin RPC must not switch providers for clients');

// Clients cannot invoke provider or key operations, and never see provider vocabulary.
const manifest = JSON.parse(readFileSync(join(root, 'plugins/voice/muxr-ui.json'), 'utf8'));
assert.deepEqual(Object.keys(manifest.capabilities).sort(), ['voice.report', 'voice.session', 'voice.status']);
assert.doesNotMatch(JSON.stringify(manifest), /secure-prompt|key-set|key-clear|provider-set|provider-list|providerName/, 'clients must not be offered provider or key actions');
assert.match(JSON.stringify(manifest), /"slot":\s*"host\.stream"/, 'voice provider must run behind a backend stream');
const realtimeActions = readFileSync(join(root, 'apps/mobile/sources/conversation/application/realtimeActions.ts'), 'utf8');
assert.equal(realtimeActions.includes('Modal.prompt('), false, 'kernel must not collect provider secrets');
const oversizedAudio = 'A'.repeat(160 * 1024);
const audioChunks = chunkAudio(oversizedAudio);
assert.equal(audioChunks.join(''), oversizedAudio);
assert.ok(audioChunks.length > 1 && audioChunks.every((chunk) => chunk.length <= 96 * 1024 && chunk.length % 4 === 0), 'provider audio must fit public realtime frame bounds');
for (const clientFile of ['apps/mobile/sources/conversation/application/realtimeSession.ts', 'apps/mobile/sources/app/(app)/settings/voice.tsx', 'apps/mobile/sources/conversation/application/realtimeActions.ts']) {
    assert.doesNotMatch(readFileSync(join(root, clientFile), 'utf8'), /OpenAI|xAI|Grok|Gemini|api\.[a-z]+\.ai|gpt-|grok-/i, `${clientFile} must stay provider-blind`);
}
for (const adapter of ['xai', 'openai', 'gemini', 'codex'].map((id) => `plugins/voice/providers/${id}.mjs`)) {
    const source = readFileSync(join(root, adapter), 'utf8');
    assert.doesNotMatch(source, /name:\s*['"](?:herdr_cli|close_pane)['"]|args\.confirmed/, `${adapter} must not let model arguments authorize destructive local tools`);
}
process.stdout.write('voice plugin: host-owned provider policy, provider-neutral client contract passed\n');
