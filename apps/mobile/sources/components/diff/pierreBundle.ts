/**
 * One async boundary for both @pierre/diffs entry points. Two separate
 * dynamic imports made Metro treat their shared subtree (shiki and every
 * grammar, ~2.7 MB raw) as common code and ship it in the eager __common
 * chunk; one boundary keeps it in this lazy chunk.
 */
import * as main from '@pierre/diffs';
import * as react from '@pierre/diffs/react';

export { main, react };
