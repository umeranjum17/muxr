/**
 * Every reader of the syntax highlighter (prism) behind one lazy boundary.
 *
 * Metro files any module shared between two lazy chunks into the eager
 * `__common` chunk, which index.html loads before first paint. The document
 * viewer, the diff surfaces and the changelog's markdown all reach prism, so
 * splitting them into separate lazy chunks would push prism back into
 * `__common`. They load together instead, only when a screen that shows code
 * or a diff opens -- never on the landing or pair routes.
 */
export { CodeCore } from './CodeCore';
export { DocumentViewer } from '@/components/document/DocumentViewer';
export { PatchSurface } from '@/components/diff/PatchSurface';
export { NavigableDiff } from '@/components/diff/NavigableDiff';
export { MarkdownView } from '@/components/markdown/MarkdownView';
