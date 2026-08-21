// Where each beat starts in the finished film, derived from the same timing the
// film is cut with rather than read off a stopwatch. Consumed by muxr-cloud's
// scripts/import-film.mjs so the site's chapter list cannot drift from the cut.
//
//   node lib/beats.mjs > beats.json
import { scenes, timing } from './scenes.mjs';

/** Site-side beat ids, in film order. `same` is the desk shot, `diff` is changes. */
const ID = { herd: 'herd', terminal: 'same', changes: 'diff', files: 'files', usage: 'usage', plugins: 'plugins', inbox: 'inbox' };

const shots = scenes.filter((s) => s.reel).sort((a, b) => a.reel.order - b.reel.order);
const fps = 30;

const beats = [{ id: 'title', at: 0 }];
// A TransitionSeries overlaps each cut, so a sequence starts one transition
// earlier than its predecessor's end.
let start = timing.title - timing.transition;
for (const shot of shots) {
    beats.push({ id: ID[shot.id] ?? shot.id, at: Number((start / fps).toFixed(2)) });
    start += timing.shot - timing.transition;
}
beats.push({ id: 'close', at: Number((start / fps).toFixed(2)) });

// The desk shot: the film's own argument, and the frame the page uses as poster.
const same = beats.find((b) => b.id === 'same');
const posterAt = Number((same.at + (timing.shot / fps) * 0.5).toFixed(2));

process.stdout.write(`${JSON.stringify({ beats, posterAt }, null, 4)}\n`);
