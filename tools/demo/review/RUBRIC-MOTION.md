# The motion bar

Scored on the rendered film, using contact strips rather than impressions:

    node review/strip.mjs review/film.mp4 <start> <end> 10 review/frames/strip.png

A strip shows where the frames actually are. Even spacing across a strip is
linear motion, whatever the code claims. Judge from strips, not from vibes.

Six dimensions, 0–10. **Overall is the LOWEST, not the average.**

### 1. Timing contrast
Durations must differ by mass. A headline and a hairline rule cannot share a
duration. If every entrance is the same length, this scores 3.

### 2. Follow-through and overlap
Nothing arrives with anything else. Light elements lead, heavy ones lag, and
the gap is visible in the strip. Elements landing on the same frame is the
single most common tell.

### 3. Easing
Curves chosen per role, verified in the strip: an eased entrance shows frames
bunching toward the end. Default `ease` / `ease-in-out` / linear all fail.

### 4. Entrance ≠ exit
Exits must be shorter and subtler than entrances. An exit that is the entrance
reversed scores 4.

### 5. Rhythm across beats
Beat lengths and internal pacing must vary. Eleven identically-paced beats is a
slideshow, not a film. Check the cut points against each other.

### 6. Restraint
Nothing moves that does not need to. No pulsing, no breathing, no floating, no
parallax for its own sake, no camera drift on a static frame. If a viewer
notices the animation itself, it is too much.

## Automatic failures

- Four or more elements sharing an identical entrance
- Any looped pulse/glow/breathe on an indicator
- Motion on a text element whose only purpose is the entrance
- A screen that drifts, floats, or bobs while nothing is happening
- Frames that are identical across a transition (a stall)
- Any per-frame jitter: the previous version shook and it was the loudest
  complaint of the whole project

## What a 9.5 looks like

The film reads as edited, not assembled. You can feel where the cuts are before
you see them. Nothing calls attention to its own animation, and no two beats
feel the same length.
