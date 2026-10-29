import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { UnistylesRuntime } from 'react-native-unistyles';
import { storage } from '@/catalog/store';
import { darkThemes, lightTheme, type DarkSurfaces } from '@/theme';

export type ThemePreference = 'adaptive' | 'light' | 'dark';

export function applyTheme(next: ThemePreference, surfaces: DarkSurfaces): void {
    UnistylesRuntime.setAdaptiveThemes(next === 'adaptive');
    if (next !== 'adaptive') UnistylesRuntime.setTheme(next);
    const dark = next === 'adaptive' ? Appearance.getColorScheme() === 'dark' : next === 'dark';
    const color = dark ? darkThemes[surfaces].colors.groupped.background : lightTheme.colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    void SystemUI.setBackgroundColorAsync(color);
}

/** Appearance's Theme row, for callers with no screen: keep the choice, then repaint now. */
export function setThemePreference(next: ThemePreference): void {
    storage.getState().applyLocalSettings({ themePreference: next });
    applyTheme(next, storage.getState().localSettings.darkSurfaces);
}
