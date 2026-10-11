import { expect, it } from 'vitest';
import { agentFolderName, derivedAgentName } from './agentName.js';

it('derives the last folder segment and ignores trailing slashes, empty or root paths, and long slash runs', () => {
    expect(agentFolderName('a/b///')).toBe('b');
    expect(agentFolderName('a/b/')).toBe('b');
    expect(agentFolderName('/a/b')).toBe('b');
    expect(agentFolderName('/')).toBeUndefined();
    expect(agentFolderName('')).toBeUndefined();
    expect(agentFolderName(undefined)).toBeUndefined();
    expect(agentFolderName('/'.repeat(100000))).toBeUndefined();
    expect(derivedAgentName({ cwd: 'a/b///' })).toBe('b');
    expect(derivedAgentName({ cwd: '/'.repeat(100000) })).toBe('Agent');
});
