/**
 * P1 flow: the OpenCode launch config over a throwaway account root. The
 * attachment pre-allow lands in the account's own opencode.json, reads-only
 * for exactly muxr's attachment folder; an ambient launch carries it as
 * OPENCODE_CONFIG_CONTENT and never writes the user's config.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { allowOpencodeAttachments, opencodeAttachmentEnv } from './opencodeAccounts.js';

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

/** An ambient launch: the user's own HOME/XDG, a project at its git root. */
function ambient(extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; cwd: string; userConfig: string } {
    const cwd = join(root, 'project');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const userConfig = join(root, 'user', '.config', 'opencode');
    return { env: { HOME: join(root, 'user'), XDG_CONFIG_HOME: join(root, 'user', '.config'), ...extra }, cwd, userConfig };
}

it('pre-allows the folder for an ambient launch through config content, writing no file', () => {
    const { env, cwd, userConfig } = ambient();
    const dir = join(root, 'muxr-home', 'host', 'attachments');
    const injected = opencodeAttachmentEnv(env, dir, cwd);
    expect(JSON.parse(injected.OPENCODE_CONFIG_CONTENT!)).toEqual({
        permission: { external_directory: { [`${dir}/**`]: 'allow' }, edit: { [`${dir}/**`]: 'deny' } },
    });
    expect(existsSync(userConfig)).toBe(false);
});

it("carries the user's own string rules in, so edit: ask stays ask", () => {
    const { env, cwd, userConfig } = ambient();
    mkdirSync(userConfig, { recursive: true });
    writeFileSync(join(userConfig, 'opencode.json'), JSON.stringify({ permission: { edit: 'ask', external_directory: 'deny', bash: 'allow' } }));
    // A project file merges over the global one, as OpenCode does.
    writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({ permission: { edit: { 'src/**': 'allow' } } }));
    const dir = join(root, 'atts');
    const content = JSON.parse(opencodeAttachmentEnv(env, dir, cwd).OPENCODE_CONFIG_CONTENT!) as { permission: Record<string, Record<string, string>> };
    expect(content.permission.external_directory).toEqual({ '*': 'deny', [`${dir}/**`]: 'allow' });
    expect(content.permission.edit).toEqual({ 'src/**': 'allow', [`${dir}/**`]: 'deny' });
    // Only the two rules travel: every other tool keeps the user's own merge.
    expect(Object.keys(content.permission)).toEqual(['external_directory', 'edit']);
});

it('injects nothing when the host already sets config content, or a config cannot be read', () => {
    const own = ambient({ OPENCODE_CONFIG_CONTENT: '{"model":"x"}' });
    expect(opencodeAttachmentEnv(own.env, join(root, 'atts'), own.cwd)).toEqual({});

    const { env, cwd, userConfig } = ambient();
    mkdirSync(userConfig, { recursive: true });
    writeFileSync(join(userConfig, 'opencode.jsonc'), '{ // jsonc\n "permission": { "edit": "ask" } }');
    expect(opencodeAttachmentEnv(env, join(root, 'atts'), cwd)).toEqual({});
    rmSync(join(userConfig, 'opencode.jsonc'));
    writeFileSync(join(userConfig, 'opencode.json'), JSON.stringify({ permission: 'ask' }));
    expect(opencodeAttachmentEnv(env, join(root, 'atts'), cwd)).toEqual({});
});
