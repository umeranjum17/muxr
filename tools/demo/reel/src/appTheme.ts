// Source-faithful subset of apps/mobile/sources/theme.ts. Keep values literal:
// README films should change only when the shipping app does.
export const app = {
    light: {
        text: '#000000', textSecondary: '#8E8E93', textLink: '#007AFF',
        accent: '#17171a', success: '#34C759', error: '#FF3B30', warning: '#8E8E93',
        surface: '#ffffff', surfaceHigh: '#F8F8F8', surfaceHighest: '#f0f0f0', divider: '#eaeaea',
        grouped: '#F2F2F7', chevron: '#C7C7CC', glass: 'rgba(255,255,255,.84)',
        terminal: '#1E1E1E', terminalInk: '#E0E0E0',
        diff: {
            outline: '#E0E0E0', success: '#28A745', error: '#DC3545',
            addedText: '#116329', removedText: '#82071E', contextText: '#586069',
            lineNumberText: '#959DA5', hunkHeaderBg: '#F1F8FF', hunkHeaderText: '#005CC5',
        },
    },
    dark: {
        text: '#ececec', textSecondary: '#9a9a9f', surface: '#1a1a1a',
        surfaceHigh: '#212121', surfaceHighest: '#2a2a2a', divider: '#2e2e2e',
        terminal: '#0c0c0b', success: '#30D158', working: '#0A84FF', error: '#FF453A',
    },
} as const;
