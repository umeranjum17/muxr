import { describe, expect, it } from 'vitest';
import {
    MuxrConfigError,
    muxrConfigPath,
    parseMuxrConfigFile,
    resolveHostConfig,
} from './config.js';

const PATH = '/tmp/muxr-test-home/config.json';
const DEFAULTS = {
    mode: 'local' as const,
    relayUrl: 'ws://127.0.0.1:8792',
    machineId: 'devbox',
    machineName: 'devbox',
    dataDir: '/tmp/muxr-test-home/host',
    hostHttpPort: 8793,
};

/** One flow: file on disk -> parse -> precedence -> host settings. */
describe('muxr config file', () => {
    it('lives beside the other MUXR_HOME state and falls back when absent', () => {
        expect(muxrConfigPath({ MUXR_HOME: '/tmp/muxr-test-home' })).toBe(PATH);
        expect(muxrConfigPath({})).toMatch(/\.muxr\/config\.json$/);
        expect(resolveHostConfig({ argv: [], env: {}, file: {}, defaults: DEFAULTS })).toEqual(DEFAULTS);
    });

    it('applies a partial hand-edited file over defaults', () => {
        const file = parseMuxrConfigFile(PATH, JSON.stringify({ machineName: 'desk', hostHttpPort: 9999 }));
        const resolved = resolveHostConfig({ argv: [], env: {}, file, defaults: DEFAULTS });
        expect(resolved.machineName).toBe('desk');
        expect(resolved.hostHttpPort).toBe(9999);
        expect(resolved.relayUrl).toBe(DEFAULTS.relayUrl);
    });

    it('decodes operator terminal key escapes and refuses broken ones', () => {
        const file = parseMuxrConfigFile(PATH, JSON.stringify({
            terminalKeys: [
                { label: 'esc', send: '\\e' },
                { label: 'left', send: '\\e[D', repeat: true },
            ],
            quickReplies: [{ label: 'Ship', text: 'Ship it.' }],
        }));
        expect(file.terminalKeys).toEqual([
            { label: 'esc', send: '\u001b' },
            { label: 'left', send: '\u001b[D', repeat: true },
        ]);
        expect(file.quickReplies).toEqual([{ label: 'Ship', text: 'Ship it.' }]);
        expect(() => parseMuxrConfigFile(PATH, JSON.stringify({ terminalKeys: [{ label: 'bad', send: '\\q' }] })))
            .toThrow(/incomplete escape/);
        expect(() => parseMuxrConfigFile(PATH, JSON.stringify({ terminalKeys: [] }))).toThrow(MuxrConfigError);
        expect(() => parseMuxrConfigFile(PATH, JSON.stringify({ quickReplies: [{ label: 'x' }] }))).toThrow(MuxrConfigError);
    });

    it('prefers flag over environment over file over default per key', () => {
        const file = parseMuxrConfigFile(
            PATH,
            JSON.stringify({ relayUrl: 'ws://file:1', machineName: 'file', hostHttpPort: 1111 }),
        );
        const env = { MUXR_RELAY_URL: 'ws://env:2', MUXR_MACHINE_NAME: 'env', MUXR_HOST_HTTP_PORT: '2222' };
        const argv = ['--relay-url', 'ws://flag:3'];
        const resolved = resolveHostConfig({ argv, env, file, defaults: DEFAULTS });
        expect(resolved.relayUrl).toBe('ws://flag:3');
        expect(resolved.machineName).toBe('env');
        expect(resolved.hostHttpPort).toBe(2222);
        const fromFile = resolveHostConfig({ argv: [], env: {}, file, defaults: DEFAULTS });
        expect(fromFile.relayUrl).toBe('ws://file:1');
    });

    it('reports a broken file with path and key and never half-applies', () => {
        const cases: Array<[string, string, string]> = [
            ['{oops', '(file)', 'malformed JSON'],
            ['[1,2]', '(file)', 'must be a JSON object'],
            [JSON.stringify({ relayUrl: 'http://plain' }), 'relayUrl', 'ws:// or wss://'],
            [JSON.stringify({ mode: 'cloud' }), 'mode', 'hosted'],
            [JSON.stringify({ hostHttpPort: 99999 }), 'hostHttpPort', '1 to 65535'],
            [JSON.stringify({ dataDir: 'relative/path' }), 'dataDir', 'absolute path'],
            [JSON.stringify({ mystery: 1 }), 'mystery', 'unknown setting'],
        ];
        for (const [text, key, reason] of cases) {
            let error: unknown;
            try {
                parseMuxrConfigFile(PATH, text);
            } catch (cause) {
                error = cause;
            }
            expect(error).toBeInstanceOf(MuxrConfigError);
            const message = (error as Error).message;
            expect(message).toContain(PATH);
            expect(message).toContain(key);
            expect(message).toContain(reason);
        }
    });
});
