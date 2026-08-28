import { describe, expect, it } from 'vitest';
import { agentKindsFromManifests } from './agentKinds.js';

describe('agentKindsFromManifests', () => {
    it('includes hook-only agents missing from Herdr screen manifests', () => {
        expect(agentKindsFromManifests([{ agent: 'opencode' }, { agent: 'pi' }])).toEqual([
            'omp',
            'mastracode',
            'opencode',
            'pi',
        ]);
    });
});
