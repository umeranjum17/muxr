/**
 * Realtime voice is product code: prove the machine-held credential lifecycle
 * and the engine selection on muxr's own module, with no plugin in the path.
 *
 * Security path: the key store's owner-only mode, the atomic write, the
 * refusal to remove a non-regular file, and the selection file's mode all stay
 * covered here.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'muxr-voice-product-'));
process.env.MUXR_HOME = home;
// Any leftover plugin state directory must be ignored: the product module reads
// muxr's own voice state, never a plugin's.
const legacyState = join(home, 'plugin-state', 'muxr.voice');
mkdirSync(legacyState, { recursive: true, mode: 0o700 });
writeFileSync(join(legacyState, 'provider'), 'xai\n', { mode: 0o600 });

const voice = await import(pathToFileURL(join(root, 'apps/host/src/voice/product.mjs')).href);
const voiceRoot = join(root, 'apps/host/src/voice');

// 1. A fresh machine has no bundled add-on and defaults to the login-based adapter.
const initial = await voice.voiceProviderList();
assert.equal(initial.selected, 'codex', 'fresh voice configuration defaults to Codex');
for (const provider of initial.providers) {
    assert.ok(['api-key', 'codex-login'].includes(provider.setup), `${provider.id} names a native setup surface`);
}
assert.equal(existsSync(join(home, 'voice', 'provider')), false, 'reading never writes a selection');

// 2. The selection is muxr state, not plugin state, and is owner-only.
await voice.voiceProviderSet('xai');
const selectionFile = join(home, 'voice', 'provider');
assert.equal(readFileSync(selectionFile, 'utf8').trim(), 'xai');
assert.equal(statSync(selectionFile).mode & 0o077, 0, 'engine selection is owner-only');
assert.equal(readFileSync(join(legacyState, 'provider'), 'utf8').trim(), 'xai', 'plugin state is left untouched');
await assert.rejects(() => voice.voiceProviderSet('unknown'), /unknown realtime voice provider/);
assert.equal((await voice.voiceProviderList()).selected, 'xai', 'a failed switch retains the selection');

// 3. The API-key store is owner-only, atomic, and refuses anything but a regular file.
assert.deepEqual(
    { configured: (await voice.voiceStatus()).configured, label: (await voice.voiceStatus()).statusLabel },
    { configured: false, label: 'No key set' },
);
await voice.voiceKeySet('xai-test-not-a-live-secret');
const keyFile = join(home, 'xai.key');
assert.equal(statSync(keyFile).mode & 0o077, 0, 'the key file is owner-only');
assert.equal(statSync(home).mode & 0o077, 0, 'the key store directory is owner-only');
assert.equal(readFileSync(keyFile, 'utf8').trim(), 'xai-test-not-a-live-secret');
assert.deepEqual(
    { configured: (await voice.voiceStatus()).configured, label: (await voice.voiceStatus()).statusLabel },
    { configured: true, label: 'Key set' },
);
await voice.voiceKeyClear();
assert.equal(existsSync(keyFile), false, 'clearing removes the key file');
await voice.voiceKeyClear();
assert.ok(true, 'clearing an absent key is a no-op');

const victim = join(home, 'victim.txt');
writeFileSync(victim, 'do not remove\n');
const link = join(home, 'xai.key');
symlinkSync(victim, link);
await assert.rejects(() => voice.voiceKeyClear(), /Refusing to remove non-regular key file/);
assert.equal(existsSync(victim), true, 'a symlinked key path never deletes its target');

// 4. The login-based adapter owns its own readiness and takes no key.
await voice.voiceProviderSet('codex');
await assert.rejects(() => voice.voiceKeySet('unused'), /does not use an API key/);

// 5. Agent-stop reporting keeps its bounded, product-owned sentence shape.
const report = voice.voiceReport({ displayName: 'Maria', taskTitle: 'Stabilize voice', status: 'blocked', outcome: 'blocked', tail: 'raw pane text' });
assert.equal(typeof report.say, 'string');
assert.match(report.say, /Host-confirmed report/);
assert.match(report.say, /<untrusted-agent-output>[\s\S]*raw pane text[\s\S]*<\/untrusted-agent-output>/);
assert.match(voice.voiceReport({ displayName: 'Maria', taskTitle: 'Stabilize voice', status: 'idle', outcome: 'done' }).say, /Host-confirmed report/);

// 6. Retirement policy scan, not behavioural proof: voice must stay product
//    code and never return as a plugin. The parity gate that drives voice.stream
//    with no catalog entry or approval is the behavioural proof.
for (const file of ['stream.mjs', 'provider.mjs', 'product.mjs', 'toolRuntime.mjs']) {
    const source = readFileSync(join(voiceRoot, file), 'utf8');
    assert.doesNotMatch(source, /muxr-ui\.json|herdr-plugin\.toml|plugin_host|capabilities\s*\[\s*'voice/, `retirement policy: ${file} must not reference a plugin manifest or host`);
}

process.stdout.write('ok: realtime voice product lifecycle (selection, key store, reporting)\n');
