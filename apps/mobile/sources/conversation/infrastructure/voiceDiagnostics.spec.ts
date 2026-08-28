import { afterEach, describe, expect, it, vi } from 'vitest';
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
