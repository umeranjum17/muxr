// Where each beat starts in the finished film, derived from the timing the film
// is cut with rather than read off a stopwatch. Consumed by muxr-cloud's
// scripts/import-film.mjs so the site's chapter list cannot drift from the cut.
//
//   node lib/beats.mjs > beats.json
import { timing } from './scenes.mjs';

/** Beat order, matching reel/src/Reel.tsx, named for the site's chapter list. */
const BEATS = ['herd', 'same', 'voice', 'diff', 'files', 'usage', 'plugins', 'authoring', 'connection', 'inbox'];

const fps = 30;
const beats = [{ id: 'title', at: 0 }];

// A TransitionSeries overlaps each cut, so a sequence starts one transition
// earlier than its predecessor's end.
let start = timing.title - timing.transition;
for (const id of BEATS) {
    beats.push({ id, at: Number((start / fps).toFixed(2)) });
    start += timing.beat - timing.transition;
}
beats.push({ id: 'close', at: Number((start / fps).toFixed(2)) });

// The `same` beat is the film's own argument, and the frame the page uses as
// its poster.
const same = beats.find((b) => b.id === 'same');
const posterAt = Number((same.at + (timing.beat / fps) * 0.55).toFixed(2));

process.stdout.write(`${JSON.stringify({ beats, posterAt }, null, 4)}\n`);
