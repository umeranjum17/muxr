import { fail, ok, type Outcome } from '../../shared/outcome.js';
import type { PluginManifestV1 } from '../domain/plugins.js';
import { parseManifest } from '../infrastructure/manifest.js';

/** Parse an untrusted plugin manifest into the domain graph. */
export function parsePluginManifest(command: { source: unknown }): Outcome<PluginManifestV1> {
    try {
        return ok(parseManifest(command.source));
    } catch (error) {
        return fail(error instanceof Error ? error.message : 'invalid muxr plugin manifest');
    }
}

export function tryParseManifest(value: unknown): Outcome<PluginManifestV1> {
    return parsePluginManifest({ source: value });
}
