import { staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';

// Monochrome on purpose. apps/mobile/sources/components/ui.tsx states the law
// the product lives by: "chrome is neutral, one accent carries emphasis, and
// status hues are spent on text, dots and small glyphs — never on a fill wider
// than a number." muxr's accent is `#17171a` on paper and `#ececec` on ink —
// there is no brand colour to tint the marketing with, and inventing one makes
// the art look like something else's.
export const ink = '#0a0a0b';
export const inkRaised = '#141416';
export const text = '#f4f4f5';
export const muted = '#8b8b90';
/** The dark theme's accent, used for rules and the kicker. */
export const accent = '#ececec';
/** One soft key light behind the handset, white, so nothing reads as a tint. */
export const halo = 'rgba(255, 255, 255, 0.055)';

export const DISPLAY = 'Bricolage';
export const SANS = 'Plex';
export const MONO = 'PlexMono';

// Remotion waits on these before the first frame is rendered.
export const fontsReady = Promise.all([
    loadFont({ family: DISPLAY, url: staticFile('fonts/BricolageGrotesque-Bold.ttf'), weight: '700' }),
    loadFont({ family: SANS, url: staticFile('fonts/IBMPlexSans-Regular.ttf'), weight: '400' }),
    loadFont({ family: SANS, url: staticFile('fonts/IBMPlexSans-SemiBold.ttf'), weight: '600' }),
    loadFont({ family: MONO, url: staticFile('fonts/IBMPlexMono-Regular.ttf'), weight: '400' }),
]);
