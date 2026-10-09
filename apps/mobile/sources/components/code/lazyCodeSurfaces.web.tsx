import * as React from 'react';
import type * as Surfaces from './codeSurfaces';

/** One dynamic-import target, so Metro emits one chunk and never a shared one. */
const load = () => import('./codeSurfaces');

const LazyCodeCore = React.lazy(() => load().then((module) => ({ default: module.CodeCore })));
const LazyDocumentViewer = React.lazy(() => load().then((module) => ({ default: module.DocumentViewer })));
const LazyPatchSurface = React.lazy(() => load().then((module) => ({ default: module.PatchSurface })));
const LazyNavigableDiff = React.lazy(() => load().then((module) => ({ default: module.NavigableDiff })));
const LazyMarkdownView = React.lazy(() => load().then((module) => ({ default: module.MarkdownView })));

export function CodeCore(props: React.ComponentProps<typeof Surfaces.CodeCore>) {
    return <React.Suspense fallback={null}><LazyCodeCore {...props} /></React.Suspense>;
}
export function DocumentViewer(props: React.ComponentProps<typeof Surfaces.DocumentViewer>) {
    return <React.Suspense fallback={null}><LazyDocumentViewer {...props} /></React.Suspense>;
}
export function PatchSurface(props: React.ComponentProps<typeof Surfaces.PatchSurface>) {
    return <React.Suspense fallback={null}><LazyPatchSurface {...props} /></React.Suspense>;
}
export function NavigableDiff(props: React.ComponentProps<typeof Surfaces.NavigableDiff>) {
    return <React.Suspense fallback={null}><LazyNavigableDiff {...props} /></React.Suspense>;
}
export function MarkdownView(props: React.ComponentProps<typeof Surfaces.MarkdownView>) {
    return <React.Suspense fallback={null}><LazyMarkdownView {...props} /></React.Suspense>;
}
