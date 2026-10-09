/**
 * What `import "shiki"` resolves to on web (metro.config.js), for the diff
 * viewer. The grammars people diff most are imported statically, so they live
 * in the lazy diff chunk. Every other grammar comes from shiki's own lazy
 * language loader, so each one is fetched in its own chunk only when a diff
 * needs it.
 */
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from '@shikijs/core';
import type { LanguageRegistration } from '@shikijs/core';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
import {
    bundledLanguagesAlias as lazyAliases,
    bundledLanguagesBase as lazyBases,
    bundledLanguagesInfo as lazyInfo,
} from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';
import c from '@shikijs/langs/c';
import cpp from '@shikijs/langs/cpp';
import css from '@shikijs/langs/css';
import diff from '@shikijs/langs/diff';
import dockerfile from '@shikijs/langs/dockerfile';
import go from '@shikijs/langs/go';
import graphql from '@shikijs/langs/graphql';
import html from '@shikijs/langs/html';
import ini from '@shikijs/langs/ini';
import java from '@shikijs/langs/java';
import javascript from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import jsonc from '@shikijs/langs/jsonc';
import jsx from '@shikijs/langs/jsx';
import kotlin from '@shikijs/langs/kotlin';
import make from '@shikijs/langs/make';
import markdown from '@shikijs/langs/markdown';
import php from '@shikijs/langs/php';
import python from '@shikijs/langs/python';
import ruby from '@shikijs/langs/ruby';
import rust from '@shikijs/langs/rust';
import scss from '@shikijs/langs/scss';
import shellscript from '@shikijs/langs/shellscript';
import sql from '@shikijs/langs/sql';
import swift from '@shikijs/langs/swift';
import toml from '@shikijs/langs/toml';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import xml from '@shikijs/langs/xml';
import yaml from '@shikijs/langs/yaml';

export * from '@shikijs/core';
export { bundledThemes, bundledThemesInfo } from 'shiki/themes';
export { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
export { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
const eager: Record<string, LanguageRegistration[]> = {
    c, cpp, css, diff, dockerfile, go, graphql, html, ini, java, javascript, json, jsonc, jsx, kotlin, make,
    markdown, php, python, ruby, rust, scss, shellscript, sql, swift, toml, tsx, typescript, xml, yaml,
};
const eagerLoader = (grammar: LanguageRegistration[]) => () => Promise.resolve({ default: grammar });
const eagerBases = Object.fromEntries(Object.entries(eager).map(([id, grammar]) => [id, eagerLoader(grammar)]));
const eagerAliases = Object.fromEntries(Object.entries(eager).flatMap(([id, grammar]) =>
    (grammar[grammar.length - 1]?.aliases ?? []).map((alias) => [alias, eagerLoader(grammar)])));
export const bundledLanguagesBase = { ...lazyBases, ...eagerBases };
export const bundledLanguagesAlias = { ...lazyAliases, ...eagerAliases };
export const bundledLanguages = { ...bundledLanguagesBase, ...bundledLanguagesAlias };
export const bundledLanguagesInfo = lazyInfo.map((info) => ({ ...info, import: bundledLanguagesBase[info.id] ?? info.import }));

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
