/**
 * What `import "shiki"` resolves to on web (metro.config.js), for the diff
 * viewer. Every grammar comes from shiki's own lazy language loader, so each
 * one is fetched in its own chunk only when a diff needs it and none is shared
 * into the eager __common chunk.
 */
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from '@shikijs/core';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
import { bundledLanguages } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';

export * from '@shikijs/core';
export { bundledLanguages, bundledLanguagesAlias, bundledLanguagesBase, bundledLanguagesInfo } from 'shiki/langs';
export { bundledThemes, bundledThemesInfo } from 'shiki/themes';
export { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
export { createOnigurumaEngine } from '@shikijs/engine-oniguruma';

export const createHighlighter = createBundledHighlighter({
    langs: bundledLanguages,
    themes: bundledThemes,
    engine: () => createOnigurumaEngine(import('shiki/wasm')),
});
export const {
    codeToHtml,
    codeToHast,
    codeToTokens,
    codeToTokensBase,
    codeToTokensWithThemes,
    getSingletonHighlighter,
    getLastGrammarState,
} = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
