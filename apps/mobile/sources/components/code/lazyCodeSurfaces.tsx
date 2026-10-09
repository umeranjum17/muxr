import * as React from 'react';

/** One dynamic-import target, so Metro emits one chunk and never a shared one. */
const load = () => import('./codeSurfaces');

export const LazyCodeCore = React.lazy(() => load().then((module) => ({ default: module.CodeCore })));
export const LazyDocumentViewer = React.lazy(() => load().then((module) => ({ default: module.DocumentViewer })));
export const LazyPatchSurface = React.lazy(() => load().then((module) => ({ default: module.PatchSurface })));
export const LazyNavigableDiff = React.lazy(() => load().then((module) => ({ default: module.NavigableDiff })));
export const LazyMarkdownView = React.lazy(() => load().then((module) => ({ default: module.MarkdownView })));
