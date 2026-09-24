import { Platform } from 'react-native';

/**
 * The terminal's own ground, which the header and rails share so the screen
 * reads as one surface. Android's terminal surface keeps the black it is
 * created with and takes a theme background only on some later updates, so
 * there the ground IS that black: header, rails and terminal then match
 * however the theme lands. Elsewhere the near-black the terminal honours.
 */
export const terminalCanvas = Platform.OS === 'android' ? '#000000' : '#0c0c0b';

const terminalChrome = {
    canvas: terminalCanvas,
    chrome: '#191918',
    floating: 'rgba(25, 25, 24, 0.95)',
    // Opaque enough that terminal text does not read through the resting disc.
    resting: 'rgba(25, 25, 24, 0.92)',
    cluster: 'rgba(48, 48, 46, 0.92)',
    clusterPressed: 'rgba(72, 72, 69, 0.96)',
    scrim: 'rgba(0, 0, 0, 0.62)',
};

export const lightTheme = {
    dark: false,
    colors: {

        //
        // Main colors
        //

        text: '#000000',
        textDestructive: Platform.select({ ios: '#FF3B30', default: '#F44336' }),
        textSecondary: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
        textLink: '#007AFF',
        accent: '#17171a',
        accentSubtle: 'rgba(23, 23, 26, 0.10)',
        accentFaint: 'rgba(23, 23, 26, 0.04)',
        deleteAction: '#FF6B6B', // Delete/remove button color
        warningCritical: '#FF3B30',
        warning: '#8E8E93',
        success: '#34C759',
        surface: '#ffffff',
        surfaceRipple: 'rgba(0, 0, 0, 0.08)',
        surfacePressed: '#f0f0f2',
        surfaceSelected: Platform.select({ ios: '#C6C6C8', default: '#eaeaea' }),
        surfacePressedOverlay: Platform.select({ ios: '#D1D1D6', default: 'transparent' }),
        surfaceHigh: '#F8F8F8',
        surfaceHighest: '#f0f0f0',
        divider: Platform.select({ ios: '#eaeaea', default: '#eaeaea' }),
        scrim: 'rgba(0, 0, 0, 0.67)',
        shadow: {
            color: Platform.select({ default: '#000000', web: 'rgba(0, 0, 0, 0.1)' }),
            opacity: 0.1,
        },
        glass: {
            background: 'rgba(255, 255, 255, 0.68)',
            backgroundStrong: 'rgba(255, 255, 255, 0.84)',
            backgroundSubtle: 'rgba(255, 255, 255, 0.42)',
            overlay: 'rgba(245, 245, 248, 0.58)',
            overlayTint: 'rgba(255, 255, 255, 0.46)',
            border: 'rgba(255, 255, 255, 0.82)',
            divider: 'rgba(60, 60, 67, 0.12)',
            highlight: 'rgba(255, 255, 255, 0.94)',
            shadow: 'rgba(39, 47, 54, 0.16)',
            tint: 'rgba(255, 255, 255, 0.14)',
            backdrop: ['#F5F2EC', '#ECF5F3', '#F1EEF7'] as readonly [string, string, string],
            glowPrimary: 'rgba(96, 211, 184, 0.18)',
            glowSecondary: 'rgba(118, 139, 255, 0.14)',
        },

        //
        // System components
        //

        groupped: {
            background: Platform.select({ ios: '#F2F2F7', default: '#F5F5F5' }),
            chevron: Platform.select({ ios: '#C7C7CC', default: '#49454F' }),
            sectionTitle: Platform.select({ ios: '#8E8E93', default: '#49454F' }),
            // Tree connector rail in grouped lists (iOS separator family).
            rail: '#D1D1D6',
        },
        header: {
            background: '#ffffff',
            tint: '#18171C'
        },
        switch: {
            track: {
                active: Platform.select({ ios: '#34C759', default: '#1976D2' }),
                inactive: '#dddddd',
            },
            thumb: {
                active: '#FFFFFF',
                inactive: '#767577',
            },
        },
        fab: {
            background: '#000000',
            backgroundPressed: '#1a1a1a',
            icon: '#FFFFFF',
        },
        radio: {
            active: '#007AFF',
            inactive: '#C0C0C0',
            dot: '#007AFF',
        },
        modal: {
            border: 'rgba(0, 0, 0, 0.1)'
        },
        button: {
            primary: {
                background: '#000000',
                tint: '#FFFFFF',
                disabled: '#C0C0C0',
            },
            secondary: {
                tint: '#666666',
            }
        },
        input: {
            background: '#F5F5F5',
            text: '#000000',
            placeholder: '#999999',
        },
        box: {
            warning: {
                background: '#FFF8F0',
                border: '#FF9500',
                text: '#FF9500',
            },
            error: {
                background: '#FFF0F0',
                border: '#FF3B30',
                text: '#FF3B30',
            }
        },

        //
        // App components
        //

        status: {
            connected: '#34C759',
            connecting: '#007AFF',
            disconnected: '#999999',
            error: '#FF3B30',
            default: '#8E8E93',
            working: '#007AFF',
            done: '#34C759',
            unread: '#007AFF',
        },

        // Permission mode colors
        permission: {
            default: '#8E8E93',
            acceptEdits: '#007AFF',
            bypass: '#FF9500',
            plan: '#34C759',
            readOnly: '#8B8B8D',
            safeYolo: '#FF6B35',
            yolo: '#DC143C',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#34C759',
                text: '#FFFFFF',
            },
            deny: {
                background: '#FF3B30',
                text: '#FFFFFF',
            },
            allowAll: {
                background: '#007AFF',
                text: '#FFFFFF',
            },
            inactive: {
                background: '#E5E5EA',
                border: '#D1D1D6',
                text: '#8E8E93',
            },
            selected: {
                background: '#F2F2F7',
                border: '#D1D1D6',
                text: '#3C3C43',
            },
        },


        // Diff view
        diff: {
            outline: '#E0E0E0',
            success: '#28A745',
            error: '#DC3545',
            // Traditional diff colors
            addedBg: '#E6FFEC',
            addedBorder: '#34D058',
            addedText: '#116329',
            removedBg: '#FFEBE9',
            removedBorder: '#D73A49',
            removedText: '#82071E',
            contextBg: '#F6F8FA',
            contextText: '#586069',
            lineNumberBg: '#F6F8FA',
            lineNumberText: '#6e7781',
            hunkHeaderBg: '#F1F8FF',
            hunkHeaderText: '#005CC5',
            leadingSpaceDot: '#E8E8E8',
            inlineAddedBg: '#ACFFA6',
            inlineAddedText: '#0A3F0A',
            inlineRemovedBg: '#FFCECB',
            inlineRemovedText: '#5A0A05',
        },

        // The reading surface. A code panel is a dark object in both app
        // themes - the same way a chat client renders a code block inside a
        // light page - because a dark ground is the only one on which syntax
        // colour can be saturated and still clear 4.5:1. Primer Dark Default.
        code: {
            surface: '#141518',
            surfaceRaised: '#1c1e23',
            pressed: '#23262d',
            hairline: '#2a2d34',
            text: '#d7dae0',
            dim: '#8b949e',
            keyword: '#ff7b72',
            string: '#a5d6ff',
            number: '#79c0ff',
            function: '#d2a8ff',
            className: '#ffa657',
            tag: '#7ee787',
            addedBg: 'rgba(63,185,80,0.14)',
            addedWord: 'rgba(63,185,80,0.35)',
            addedMark: '#3fb950',
            removedBg: 'rgba(248,81,73,0.14)',
            removedWord: 'rgba(248,81,73,0.35)',
            removedMark: '#f85149',
            scopeMark: '#79c0ff',
        },

        // Code/Syntax colors
        syntaxKeyword: '#1d4ed8',
        syntaxString: '#047857',
        syntaxComment: '#6b7280',
        syntaxNumber: '#0e7490',
        syntaxFunction: '#7e22ce',
        syntaxBracket1: '#ff6b6b',
        syntaxBracket2: '#4ecdc4',
        syntaxBracket3: '#45b7d1',
        syntaxBracket4: '#f7b731',
        syntaxBracket5: '#5f27cd',
        syntaxDefault: '#374151',

        // Git status colors
        gitBranchText: '#6b7280',
        gitFileCountText: '#6b7280',
        gitAddedText: '#22c55e',
        gitRemovedText: '#ef4444',

        // Terminal/Command colors
        terminal: {
            background: '#1E1E1E',
            prompt: '#34C759',
            command: '#E0E0E0',
            stdout: '#E0E0E0',
            stderr: '#FFB86C',
            error: '#FF5555',
            emptyOutput: '#6272A4',
        },

        terminalChrome,

    },
};

export const darkTheme = {
    dark: true,
    colors: {

        //
        // Main colors
        //

        text: '#ececec',
        textDestructive: Platform.select({ ios: '#FF453A', default: '#F48FB1' }),
        // The same warm-neutral temperature as the ink ramp it sits on; a
        // blue-leaning grey on the near-black read as a second palette.
        textSecondary: '#9b9b98',
        textLink: '#0A84FF',
        accent: '#ececec',
        accentSubtle: 'rgba(236, 236, 236, 0.12)',
        accentFaint: 'rgba(236, 236, 236, 0.05)',
        deleteAction: '#FF6B6B', // Delete/remove button color (same in both themes)
        warningCritical: '#f38ba8',
        warning: '#77777d',
        success: '#94e2d5',
        // herdr ink palette: terminal darkest, app chrome one step up.
        surface: Platform.select({ web: '#1a1a1a', default: '#1a1a1a' }),
        surfaceRipple: Platform.select({ web: 'rgba(255, 255, 255, 0.08)', default: 'rgba(255, 255, 255, 0.07)' }),
        surfacePressed: '#2a2a2a',
        surfaceSelected: '#2a2a2a',
        surfacePressedOverlay: Platform.select({ web: 'transparent', default: '#2a2a2a' }),
        surfaceHigh: '#212121',
        surfaceHighest: '#2a2a2a',
        divider: '#2e2e2e',
        scrim: 'rgba(0, 0, 0, 0.67)',
        shadow: {
            color: Platform.select({ default: '#000000', web: 'rgba(0, 0, 0, 0.1)' }),
            opacity: 0.1,
        },
        glass: {
            background: 'rgba(22, 22, 22, 0.44)',
            backgroundStrong: 'rgba(28, 28, 28, 0.68)',
            backgroundSubtle: 'rgba(255, 255, 255, 0.07)',
            overlay: 'rgba(0, 0, 0, 0.72)',
            overlayTint: 'rgba(0, 0, 0, 0.56)',
            border: 'rgba(255, 255, 255, 0.14)',
            divider: 'rgba(255, 255, 255, 0.08)',
            highlight: 'rgba(255, 255, 255, 0.22)',
            shadow: 'rgba(0, 0, 0, 0.55)',
            tint: 'rgba(16, 16, 16, 0.08)',
            backdrop: ['#000000', '#000000', '#000000'] as readonly [string, string, string],
            glowPrimary: 'transparent',
            glowSecondary: 'transparent',
        },

        //
        // System components
        //

        header: {
            background: Platform.select({ web: '#212121', default: '#000000' }),
            tint: '#ffffff'
        },
        switch: {
            track: {
                active: Platform.select({ ios: '#34C759', default: '#1976D2' }),
                inactive: Platform.select({ web: '#3a393f', default: '#363636' }),
            },
            thumb: {
                active: '#FFFFFF',
                inactive: '#767577',
            },
        },
        groupped: {
            background: Platform.select({ web: '#1e1e1e', default: '#000000' }),
            chevron: Platform.select({ ios: '#505050', default: '#CAC4D0' }),
            sectionTitle: Platform.select({ ios: '#8E8E93', default: '#CAC4D0' }),
            rail: '#38383A',
        },
        fab: {
            background: '#FFFFFF',
            backgroundPressed: '#f0f0f0',
            icon: '#000000',
        },
        radio: {
            active: '#0A84FF',
            inactive: '#48484A',
            dot: '#0A84FF',
        },
        modal: {
            border: 'rgba(255, 255, 255, 0.1)'
        },
        button: {
            primary: {
                // Monochrome chrome: green/amber/cyan/purple all carry meaning in
                // terminal output, status dots and agent avatars, so the primary
                // action is plain light-on-dark and lets that colour lead.
                background: '#ececec',
                tint: '#17171a',
                disabled: '#77777d',
            },
            secondary: {
                tint: '#8E8E93',
            }
        },
        input: {
            background: Platform.select({ web: '#303030', default: '#1E1E1E' }),
            text: '#FFFFFF',
            placeholder: '#8E8E93',
        },
        box: {
            warning: {
                background: 'rgba(255, 159, 10, 0.15)',
                border: '#FF9F0A',
                text: '#FFAB00',
            },
            error: {
                background: 'rgba(255, 69, 58, 0.15)',
                border: '#FF453A',
                text: '#FF6B6B',
            }
        },

        //
        // App components
        //

        status: { // App Connection Status
            connected: '#34C759',
            connecting: '#FFFFFF',
            disconnected: '#8E8E93',
            error: '#FF453A',
            default: '#8E8E93',
            working: '#0A84FF',
            done: '#30D158',
            unread: '#0A84FF',
        },

        // Permission mode colors
        permission: {
            default: '#8E8E93',
            acceptEdits: '#0A84FF',
            bypass: '#FF9F0A',
            plan: '#32D74B',
            readOnly: '#98989D',
            safeYolo: '#FF7A4C',
            yolo: '#FF453A',
        },

        // Permission button colors
        permissionButton: {
            allow: {
                background: '#32D74B',
                text: '#FFFFFF',
            },
            deny: {
                background: '#FF453A',
                text: '#FFFFFF',
            },
            allowAll: {
                background: '#0A84FF',
                text: '#FFFFFF',
            },
            inactive: {
                background: '#2C2C2E',
                border: '#38383A',
                text: '#8E8E93',
            },
            selected: {
                background: '#1C1C1E',
                border: '#38383A',
                text: '#FFFFFF',
            },
        },


        // Diff view
        diff: {
            outline: '#30363D',
            success: '#3FB950',
            error: '#F85149',
            // Traditional diff colors for dark mode
            addedBg: '#12331F',
            addedBorder: '#3FB950',
            addedText: '#7EE787',
            removedBg: '#3A1D22',
            removedBorder: '#F85149',
            removedText: '#FFA198',
            contextBg: '#161B22',
            contextText: '#8B949E',
            lineNumberBg: '#161B22',
            lineNumberText: '#6E7681',
            hunkHeaderBg: '#161B22',
            hunkHeaderText: '#58A6FF',
            leadingSpaceDot: '#2A2A2A',
            inlineAddedBg: '#2A5A2A',
            inlineAddedText: '#7AFF7A',
            inlineRemovedBg: '#5A2A2A',
            inlineRemovedText: '#FF7A7A',
        },

        // Identical to light: the code panel is the same dark object in both
        // themes, so a file looks the same whatever the app is set to.
        code: {
            surface: '#141518',
            surfaceRaised: '#1c1e23',
            pressed: '#23262d',
            hairline: '#2a2d34',
            text: '#d7dae0',
            dim: '#8b949e',
            keyword: '#ff7b72',
            string: '#a5d6ff',
            number: '#79c0ff',
            function: '#d2a8ff',
            className: '#ffa657',
            tag: '#7ee787',
            addedBg: 'rgba(63,185,80,0.14)',
            addedWord: 'rgba(63,185,80,0.35)',
            addedMark: '#3fb950',
            removedBg: 'rgba(248,81,73,0.14)',
            removedWord: 'rgba(248,81,73,0.35)',
            removedMark: '#f85149',
            scopeMark: '#79c0ff',
        },

        // Code/Syntax colors (brighter for dark mode)
        syntaxKeyword: '#569CD6',
        syntaxString: '#CE9178',
        syntaxComment: '#6A9955',
        syntaxNumber: '#B5CEA8',
        syntaxFunction: '#DCDCAA',
        syntaxBracket1: '#FFD700',
        syntaxBracket2: '#DA70D6',
        syntaxBracket3: '#179FFF',
        syntaxBracket4: '#FF8C00',
        syntaxBracket5: '#00FF00',
        syntaxDefault: '#D4D4D4',

        // Git status colors
        gitBranchText: '#8E8E93',
        gitFileCountText: '#8E8E93',
        gitAddedText: '#34C759',
        gitRemovedText: '#FF453A',

        // Terminal/Command colors
        terminal: {
            background: '#1E1E1E',
            prompt: '#32D74B',
            command: '#E0E0E0',
            stdout: '#E0E0E0',
            stderr: '#FFB86C',
            error: '#FF6B6B',
            emptyOutput: '#7B7B93',
        },

        terminalChrome,

    },
} satisfies typeof lightTheme;

/*
 * Seamless dark: the same dark theme with its surfaces taken down to the
 * terminal's near-black, so cards, grouped rows, sheets, bars and the composer
 * blend into the page instead of sitting on it as grey slabs. Dividers keep a
 * visible step so rows and cards still separate. Raised is `darkTheme` itself.
 */
const seamlessSurface = '#0c0c0b';
const seamlessHigh = '#131312';
const seamlessPressed = '#1c1c1b';

export const darkSeamlessTheme = {
    ...darkTheme,
    colors: {
        ...darkTheme.colors,
        surface: seamlessSurface,
        surfacePressed: seamlessPressed,
        surfaceSelected: seamlessPressed,
        surfacePressedOverlay: Platform.select({ web: 'transparent', default: seamlessPressed }),
        surfaceHigh: seamlessHigh,
        surfaceHighest: seamlessPressed,
        divider: '#262625',
        glass: {
            ...darkTheme.colors.glass,
            background: 'rgba(12, 12, 11, 0.44)',
            backgroundStrong: 'rgba(12, 12, 11, 0.68)',
        },
        header: { ...darkTheme.colors.header, background: '#000000' },
        groupped: { ...darkTheme.colors.groupped, background: '#000000' },
        input: { ...darkTheme.colors.input, background: seamlessHigh },
    },
} satisfies typeof lightTheme;

export type DarkSurfaces = 'seamless' | 'raised';
export const darkThemes: Record<DarkSurfaces, typeof lightTheme> = { seamless: darkSeamlessTheme, raised: darkTheme };

export type Theme = typeof lightTheme;
