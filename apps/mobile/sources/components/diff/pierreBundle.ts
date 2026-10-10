/**
 * One async boundary for both @pierre/diffs entry points. Two separate
 * dynamic imports made Metro treat their shared subtree (shiki and every
 * grammar) as common code and ship it in the eager __common chunk; one
 * boundary keeps it in this lazy chunk.
 *
 * Head export, same method as checkWebExport.mjs pins: initial 2,346,369 B,
 * __common 650,327 B.
 */
import * as main from '@pierre/diffs';
import * as react from '@pierre/diffs/react';

export { main, react };
