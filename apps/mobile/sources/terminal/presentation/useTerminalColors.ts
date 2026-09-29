import * as React from 'react';
import { useLocalSetting } from '@/catalog/store';
import { terminalColorDefaults } from '@/theme';
import { cleanTerminalColorOverrides, resolveTerminalColors, terminalColorsFrom } from '../domain/terminalColors';

export const TERMINAL_COLOR_DEFAULTS = terminalColorsFrom(terminalColorDefaults);

/**
 * The colours Settings chose for this device's terminals: `overrides` is what
 * a renderer is handed, `colors` is every slot as drawn, for chrome that has
 * to sit flush with the terminal.
 */
export function useTerminalColors() {
    const stored = useLocalSetting('terminalColors');
    return React.useMemo(() => {
        const overrides = cleanTerminalColorOverrides(stored);
        return { overrides, colors: resolveTerminalColors(TERMINAL_COLOR_DEFAULTS, overrides) };
    }, [stored]);
}
