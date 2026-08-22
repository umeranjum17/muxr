import { staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';

// The product's own faces, loaded from the app's asset set (copied into
// public/ by the build). Nothing here is a web font: the film's type is the
// type the app ships.
loadFont({ family: 'PlexSans', url: staticFile('fonts/IBMPlexSans-Regular.ttf'), weight: '400' });
loadFont({ family: 'PlexSans', url: staticFile('fonts/IBMPlexSans-SemiBold.ttf'), weight: '600' });
loadFont({ family: 'PlexMono', url: staticFile('fonts/IBMPlexMono-Regular.ttf'), weight: '400' });

export const SANS = 'PlexSans, sans-serif';
export const MONO = 'PlexMono, monospace';
