/**
 * P1 flow: the config content an OpenCode pane starts with. It pre-allows
 * exactly muxr's attachment folder next to the user's own rules, opens a Go
 * account on the Go default model unless a config names one, and never
 * writes any file.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { opencodeConfigEnv } from './opencodeAccounts.js';

let root = '';

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oc-config-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

it('grants the one folder beside the unread user rules, defaults the Go model, and injects nothing it cannot read', () => {
    const cwd = join(root, 'project');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const userConfig = join(root, 'user', '.config', 'opencode');
    const env: NodeJS.ProcessEnv = { HOME: join(root, 'user'), XDG_CONFIG_HOME: join(root, 'user', '.config') };
    const dir = join(root, 'atts');
    const content = (extra: NodeJS.ProcessEnv = {}, goModel = false) => {
        const injected = opencodeConfigEnv({ ...env, ...extra }, dir, cwd, goModel).OPENCODE_CONFIG_CONTENT;
        return injected === undefined ? undefined : JSON.parse(injected) as { model?: string; permission: Record<string, Record<string, string>> };
    };

    // A bare launch: only the grant; a Go account also opens on the Go model. No config file is written.
    expect(content()).toEqual({ permission: { external_directory: { [`${dir}/**`]: 'allow' } } });
    expect(content({}, true)?.model).toBe('opencode-go/muse-spark-1.3-contributor');
    expect(existsSync(userConfig)).toBe(false);

    // The user's own external_directory rules travel in, merged over by a project file as OpenCode does,
    // and a model they named stands.
    mkdirSync(userConfig, { recursive: true });
    writeFileSync(join(userConfig, 'opencode.json'), JSON.stringify({ model: 'x/y', permission: { edit: 'ask', external_directory: 'deny' } }));
    writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({ permission: { edit: { 'src/**': 'allow' } } }));
    const merged = content({}, true)!;
    expect(merged.model).toBeUndefined();
    expect(merged.permission.external_directory).toEqual({ '*': 'deny', [`${dir}/**`]: 'allow' });
    expect(Object.keys(merged.permission)).toEqual(['external_directory']);

    // Config content the launch already sets, or a config that cannot be read, injects nothing.
    expect(opencodeConfigEnv({ ...env, OPENCODE_CONFIG_CONTENT: '{}' }, dir, cwd)).toEqual({});
    rmSync(join(userConfig, 'opencode.json'));
    writeFileSync(join(userConfig, 'opencode.jsonc'), '{ // jsonc\n "permission": { "edit": "ask" } }');
    expect(opencodeConfigEnv(env, dir, cwd)).toEqual({});
});
