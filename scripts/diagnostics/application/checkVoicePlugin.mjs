import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chunkAudio } from '../../../plugins/voice/providers/xai.mjs';

const root = process.cwd();
/** status also names the selected adapter now; assert the key contract, not equality. */
function assertStatus(result, expected) {
    const status = JSON.parse(result.stdout);
    assert.equal(status.configured, expected.configured);
    assert.equal(status.statusLabel, expected.statusLabel);
    assert.equal(status.providerId, 'xai', 'status must name the selected adapter');
}

const home = mkdtempSync(join(tmpdir(), 'muxr-voice-plugin-'));
const rpc = join(root, 'plugins', 'voice', 'rpc.mjs');
const run = (method, input) => spawnSync(process.execPath, [rpc, method], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(input ?? null),
    env: { PATH: process.env.PATH, HOME: home, MUXR_HOME: home, MUXR_PLUGIN_STATE_DIR: home },
});

let result = run('provider.list');
assert.equal(JSON.parse(result.stdout).selected, 'codex', 'fresh voice configuration defaults to Codex');
const providers = JSON.parse(result.stdout).providers;
const manifest = JSON.parse(readFileSync(join(root, 'plugins/voice/muxr-ui.json'), 'utf8'));
for (const provider of providers) {
    assert.ok(manifest.contributions.some((entry) => entry.slot === 'navigation.content' && entry.type === 'screen' && entry.id === provider.configurationContributionId), 'every provider has a configuration screen');
}
assert.equal(providers.find((entry) => entry.id === 'codex').configurationContributionId, 'login-screen');
assert.ok(!manifest.contributions.some((entry) => entry.slot === 'settings.items'), 'setup must not duplicate the native provider picker');
const loginScreen = manifest.contributions.find((entry) => entry.id === 'login-screen');
assert.doesNotMatch(JSON.stringify(loginScreen), /secure-prompt|key-set|key-clear/, 'Codex login setup must not offer API-key actions');
result = run('provider.set', { providerId: 'xai' });
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(run('provider.list').stdout).selected, 'xai', 'explicit selection survives another invocation');
assert.notEqual(run('provider.set', { providerId: 'unknown' }).status, 0);
assert.equal(JSON.parse(run('provider.list').stdout).selected, 'xai', 'failed switch retains selection');
result = run('status');
assert.equal(result.status, 0);
assertStatus(result, { configured: false, statusLabel: 'No key set' });
result = run('key.set', { key: 'xai-test-not-a-live-secret' });
assert.equal(result.status, 0, result.stderr);
assert.equal(statSync(join(home, 'xai.key')).mode & 0o077, 0);
assert.equal(readFileSync(join(home, 'xai.key'), 'utf8').trim(), 'xai-test-not-a-live-secret');
result = run('status');
assertStatus(result, { configured: true, statusLabel: 'Key set' });
result = run('key.clear');
assert.equal(result.status, 0, result.stderr);
result = run('status');
assertStatus(result, { configured: false, statusLabel: 'No key set' });
result = run('provider.set', { providerId: 'codex' });
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(run('provider.list').stdout).selected, 'codex');
result = run('unknown');
assert.notEqual(result.status, 0);
const realtimeActions = readFileSync(join(root, 'apps/mobile/sources/conversation/application/realtimeActions.ts'), 'utf8');
assert.equal(realtimeActions.includes('Modal.prompt('), false, 'kernel must not collect provider secrets');
const voiceManifest = readFileSync(join(root, 'plugins/voice/muxr-ui.json'), 'utf8');
assert.match(voiceManifest, /"type":\s*"secure-prompt"/, 'provider secret must use attributed plugin prompt');
assert.match(voiceManifest, /"slot":\s*"host\.stream"/, 'voice provider must run behind a backend stream');
const oversizedAudio = 'A'.repeat(160 * 1024);
const audioChunks = chunkAudio(oversizedAudio);
assert.equal(audioChunks.join(''), oversizedAudio);
assert.ok(audioChunks.length > 1 && audioChunks.every((chunk) => chunk.length <= 96 * 1024 && chunk.length % 4 === 0), 'provider audio must fit public realtime frame bounds');
const mobileRealtime = readFileSync(join(root, 'apps/mobile/sources/conversation/application/realtimeSession.ts'), 'utf8');
assert.doesNotMatch(mobileRealtime, /OpenAI|xAI|Grok|Gemini|api\.[a-z]+\.ai|gpt-|grok-/i, 'mobile realtime transport must stay provider-blind');
for (const adapter of ['xai', 'openai', 'gemini', 'codex'].map((id) => `plugins/voice/providers/${id}.mjs`)) {
    const source = readFileSync(join(root, adapter), 'utf8');
    assert.doesNotMatch(source, /name:\s*['"](?:herdr_cli|close_pane)['"]|args\.confirmed/, `${adapter} must not let model arguments authorize destructive local tools`);
}
process.stdout.write('voice plugin rpc lifecycle passed\n');
