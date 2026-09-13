import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { darkTheme, lightTheme } from '@/theme';
import { loadThemePreference } from '@/catalog/application/persistence';
import { Platform } from 'react-native';
import * as SystemUI from 'expo-system-ui';

//
// Theme
//

const appThemes = {
    light: lightTheme,
    dark: darkTheme
};

const breakpoints = {
    xs: 0, // <-- make sure to register one breakpoint with value 0
    sm: 300,
    md: 500,
    lg: 800,
    xl: 1200
    // use as many breakpoints as you need
};

export type ThemePreference = 'light' | 'dark' | 'adaptive';

// The preference at boot picks the configuration; changes after boot go
// through applyThemePreference below.
const themePreference = loadThemePreference();

const settings = themePreference === 'adaptive'
    ? {
        // When adaptive, let Unistyles handle theme switching automatically
        adaptiveThemes: true,
        CSSVars: true, // Enable CSS variables for web
    }
    : {
        // When fixed theme, set the initial theme explicitly
        initialTheme: themePreference,
        CSSVars: true, // Enable CSS variables for web
    };

//
// Bootstrap
//

type AppThemes = typeof appThemes
type AppBreakpoints = typeof breakpoints

declare module 'react-native-unistyles' {
    export interface UnistylesThemes extends AppThemes { }
    export interface UnistylesBreakpoints extends AppBreakpoints { }
}

StyleSheet.configure({
    settings,
    breakpoints,
    themes: appThemes,
})

/**
 * The ground behind the app follows the theme in force. Native's root view
 * shows behind navigator transitions; web's ground is CSS (theme.css) and
 * follows the theme variables by itself.
 */
function syncGround(): void {
    if (Platform.OS === 'web') return;
    const ground = appThemes[UnistylesRuntime.themeName ?? 'light'].colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(ground);
    void SystemUI.setBackgroundColorAsync(ground);
}

/**
 * Bring every theme reader back to the one theme Unistyles currently holds.
 *
 * The app paints through two representations: StyleSheet.create styles,
 * which on web are CSS variables the browser resolves from `:root`'s class
 * or the prefers-color-scheme media rule, and useUnistyles() hooks, which
 * hold a snapshot they refresh only on a Theme event. Unistyles' own
 * switching leaves the two apart: setAdaptiveThemes(true) keeps the fixed
 * theme's `:root` class, so variables stay pinned while hooks follow the
 * OS; setTheme() emits nothing when the name equals its boot snapshot, so
 * hooks keep a stale theme while the variables switch. Cleaning the class
 * list and re-emitting the current theme once (an identity updateTheme)
 * lets every mounted hook re-read the same theme the stylesheet uses.
 */
function syncThemeReaders(): void {
    const name = UnistylesRuntime.themeName ?? 'light';
    if (Platform.OS === 'web') {
        const root = document.documentElement.classList;
        root.remove('light', 'dark');
        if (!UnistylesRuntime.hasAdaptiveThemes) root.add(name);
    }
    UnistylesRuntime.updateTheme(name, (theme) => theme);
    syncGround();
}

/** The one way the theme changes after boot: the appearance setting. */
export function applyThemePreference(preference: ThemePreference): void {
    if (preference === 'adaptive') {
        UnistylesRuntime.setAdaptiveThemes(true);
    } else {
        UnistylesRuntime.setAdaptiveThemes(false);
        UnistylesRuntime.setTheme(preference);
    }
    syncThemeReaders();
}

syncGround();

// A hidden tab can miss the OS scheme change that adaptive mode follows;
// coming back re-syncs the hooks to whatever the variables already show.
// Reads the live mode, so a fixed theme chosen in this session stays.
if (Platform.OS === 'web') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && UnistylesRuntime.hasAdaptiveThemes) syncThemeReaders();
    });
}
