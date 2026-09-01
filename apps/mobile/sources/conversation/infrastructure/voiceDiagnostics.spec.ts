import { afterEach, describe, expect, it, vi } from 'vitest';
import { voicePluginFromCatalog } from '@/plugins/application/voicePluginAccess';
import { voiceDiagnostic } from './voiceDiagnostics';

describe('voice diagnostics', () => {
    afterEach(() => {
        globalThis.__VOICE_DIAGNOSTICS__ = false;
        vi.unstubAllGlobals();
    });

    it('stays silent unless development or the test flag enables it', () => {
        vi.stubGlobal('__DEV__', false);
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

        voiceDiagnostic('dictate.tap');
        expect(debug).not.toHaveBeenCalled();

        globalThis.__VOICE_DIAGNOSTICS__ = true;
        voiceDiagnostic('dictate.tap');
        expect(debug).toHaveBeenCalledWith('[voice] dictate.tap');
    });
});

describe('voice settings access', () => {
    it('keeps an explicit disable intact when voice settings open', () => {
        const catalog = [{
            summary: {
                pluginId: 'example.voice',
                name: 'Voice',
                version: '1',
                source: { kind: 'local' as const },
                manifestHash: 'hash',
                approved: false,
                capabilities: { 'voice.session': 'session' },
                hasBackend: true,
                herdrBackend: true,
                warnings: [],
            },
        }];
        const opened = voicePluginFromCatalog(catalog);
        expect(opened.status).toBe('disabled');
        expect(opened.plugin?.summary.approved).toBe(false);
        expect(voicePluginFromCatalog([{ ...catalog[0]!, summary: { ...catalog[0]!.summary, approved: true } }]).status).toBe('ready');
    });
});
