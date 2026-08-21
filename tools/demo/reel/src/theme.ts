import { staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';

export const ink = '#0b0b0d';
export const inkRaised = '#141417';
export const text = '#ececec';
export const muted = '#9a9a9f';
export const teal = 'rgba(96, 211, 184, 0.20)';
export const indigo = 'rgba(118, 139, 255, 0.16)';
export const tealSolid = '#60d3b8';

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
