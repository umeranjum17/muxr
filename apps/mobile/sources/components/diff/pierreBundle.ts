/**
 * One async boundary for both @pierre/diffs entry points. Two separate
 * dynamic imports made Metro treat their shared subtree (shiki and every
 * grammar) as common code and ship it in the eager __common chunk; one
 * boundary keeps it in this lazy chunk.
 *
 * Head export, same method as checkWebExport.mjs pins: initial 2,651,814 B,
 * __common 881,764 B. Measured in round 6 on an earlier tree: with this module
 * 2,661,138 B and 964,565 B; without it 2,806,355 B and 1,109,808 B.
 */
import * as main from '@pierre/diffs';
import * as react from '@pierre/diffs/react';

export { main, react };
