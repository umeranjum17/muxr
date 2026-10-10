/**
 * One async boundary for both @pierre/diffs entry points. Two separate
 * dynamic imports made Metro treat their shared subtree (shiki and every
 * grammar) as common code and ship it in the eager __common chunk; one
 * boundary keeps it in this lazy chunk.
 *
 * Measured with the same web export method: with this module the initial
 * payload is 2,661,138 B and __common 964,565 B; without it 2,806,355 B and
 * 1,109,808 B.
 */
import * as main from '@pierre/diffs';
import * as react from '@pierre/diffs/react';

export { main, react };
