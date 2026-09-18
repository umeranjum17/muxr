import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseManifest, type PluginManifestV1 } from '@muxr/contract';
import { rightNowBinding } from './rightNowModel';

/** The plugin record the Home renderers actually pass in. */
const installed = (manifest: PluginManifestV1) => [{ summary: { pluginId: manifest.pluginId, manifestHash: 'hash' }, manifest }];

describe('right-now selection', () => {
    it('draws the bundled status plugin as the product card', () => {
        const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../plugins/status/muxr-ui.json', import.meta.url)), 'utf8'));
        const binding = rightNowBinding(installed(parseManifest(raw)));
        expect(binding?.cardId).toBe('now.card');
        expect(binding?.contributionId).toBe('now');
        expect(binding?.contentContributionId).toBe('usage.details');
    });

    it('leaves a third-party card whose rpc is merely named `now` in its own slot', () => {
        const binding = rightNowBinding(installed(parseManifest({
            schemaVersion: 1,
            pluginId: 'you.renow',
            contributions: [
                { slot: 'host.rpc', id: 'now', type: 'rpc', method: 'now', entry: 'now.mjs', mode: 'read' },
                { slot: 'home.cards', id: 'now.card', type: 'data-card', title: 'Right now', presentation: 'card', source: { type: 'plugin.call', contributionId: 'now' } },
            ],
        })));
        expect(binding).toBeUndefined();
    });

    it('draws a third-party card that deliberately opted in, whatever its rpc is named', () => {
        const binding = rightNowBinding(installed(parseManifest({
            schemaVersion: 1,
            pluginId: 'you.optin',
            minMuxrVersion: 15,
            contributions: [
                { slot: 'host.rpc', id: 'tick', type: 'rpc', method: 'tick', entry: 'tick.mjs', mode: 'read' },
                { slot: 'home.cards', id: 'tick.card', type: 'data-card', title: 'Tick', presentation: 'card', product: 'right-now', source: { type: 'plugin.call', contributionId: 'tick' } },
            ],
        })));
        expect(binding?.cardId).toBe('tick.card');
    });
});
