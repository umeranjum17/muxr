/**
 * P1 flow: the OpenCode launch config over a throwaway account root. The
 * attachment pre-allow lands in the account's own opencode.json, reads-only
 * for exactly muxr's attachment folder, and never touches an ambient launch.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { allowOpencodeAttachments } from './opencodeAccounts.js';

let root = '';

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oc-attach-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function accountEnv(): Record<string, string> {
    return { XDG_CONFIG_HOME: join(root, 'account', '.config') };
}

function writtenConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, 'account', '.config', 'opencode', 'opencode.json'), 'utf8'));
}

it('grants the one folder read-only in a fresh account config', () => {
    const dir = join(root, 'muxr-home', 'host', 'attachments');
    allowOpencodeAttachments(accountEnv(), dir);
    const permission = writtenConfig().permission as Record<string, Record<string, string>>;
    expect(permission.external_directory).toEqual({ [`${dir}/**`]: 'allow' });
    // Reads only: the same folder must never become writable through the grant.
    expect(permission.edit).toEqual({ [`${dir}/**`]: 'deny' });
});

it('keeps an existing model choice and rule order, so our rules stand last', () => {
    const configDir = join(root, 'account', '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({
        model: 'opencode-go/muse-spark-1.3-contributor',
        permission: { external_directory: 'deny', edit: { '*': 'ask' } },
    }));
    const dir = join(root, 'muxr-home', 'host', 'attachments');
    allowOpencodeAttachments(accountEnv(), dir);
    const config = writtenConfig();
    expect(config.model).toBe('opencode-go/muse-spark-1.3-contributor');
    const permission = config.permission as { external_directory: Record<string, string>; edit: Record<string, string> };
    // A plain string was the catch-all rule; it must survive as such.
    expect(permission.external_directory['*']).toBe('deny');
    expect(permission.edit['*']).toBe('ask');
    // Last matching rule wins: the folder grant and the write ban are last.
    expect(Object.keys(permission.external_directory).at(-1)).toBe(`${dir}/**`);
    expect(permission.external_directory[`${dir}/**`]).toBe('allow');
    expect(Object.keys(permission.edit).at(-1)).toBe(`${dir}/**`);
    expect(permission.edit[`${dir}/**`]).toBe('deny');
});

it('leaves a config it cannot parse, and an ambient launch, untouched', () => {
    const configDir = join(root, 'account', '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const commented = '{ // jsonc\n "model": "x" }';
    writeFileSync(join(configDir, 'opencode.jsonc'), commented);
    allowOpencodeAttachments(accountEnv(), join(root, 'atts'));
    expect(readFileSync(join(configDir, 'opencode.jsonc'), 'utf8')).toBe(commented);
    expect(existsSync(join(configDir, 'opencode.json'))).toBe(false);

    // An ambient launch (no muxr-owned XDG root) writes nothing anywhere.
    const before = existsSync(join(root, 'atts'));
    allowOpencodeAttachments({}, join(root, 'atts'));
    expect(existsSync(join(root, 'atts'))).toBe(before);
    expect(existsSync(join(configDir, 'opencode.json'))).toBe(false);
});
