// Brand tokens, read off apps/mobile/sources/theme.ts so marketing art and the
// product cannot drift apart. Update here when the app theme changes.
// Monochrome, deliberately. apps/mobile/sources/components/ui.tsx: "chrome is
// neutral, one accent carries emphasis, and status hues are spent on text, dots
// and small glyphs — never on a fill wider than a number." muxr's accent is
// `#17171a` on paper and `#ececec` on ink; there is no brand colour, and the
// glass glow tints are 5%-opacity washes behind a blur, not something to paint
// a marketing backdrop with.
export const brand = {
    ink: '#0a0a0b',          // marketing ground, one step below app surface
    inkRaised: '#141416',
    surface: '#1a1a1a',      // darkTheme.colors.surface
    surfaceHigh: '#212121',  // darkTheme.colors.surfaceHigh
    divider: '#2e2e2e',
    text: '#f4f4f5',
    textSecondary: '#8b8b90',
    accent: '#ececec',       // darkTheme.colors.accent
    rule: 'rgba(255, 255, 255, 0.24)',
    halo: 'rgba(255, 255, 255, 0.075)',
    radius: 44,
};

/** The only colour in the set, and only ever at dot size. sessionUtils.ts:132 */
export const status = {
    working: '#0A84FF',
    blocked: '#FF453A',
    done: '#30D158',
    idle: '#8E8E93',
};

export const fonts = {
    display: 'apps/mobile/sources/assets/fonts/BricolageGrotesque-Bold.ttf',
    sans: 'apps/mobile/sources/assets/fonts/IBMPlexSans-Regular.ttf',
    sansSemi: 'apps/mobile/sources/assets/fonts/IBMPlexSans-SemiBold.ttf',
    mono: 'apps/mobile/sources/assets/fonts/IBMPlexMono-Regular.ttf',
};

export const wordmark = 'apps/mobile/sources/assets/images/wordmark@3x.png';
export const glyph = 'apps/mobile/sources/assets/images/glyph@3x.png';
