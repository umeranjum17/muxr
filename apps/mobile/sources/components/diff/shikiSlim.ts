/**
 * What `import "shiki"` resolves to on web (metro.config.js), for the diff
 * viewer. The stock bundle lazy-imports every grammar; the grammars embed
 * one another, so Metro's serializer files the shared ones under
 * `__common`, which index.html loads eagerly: ~2.7 MB of grammars before
 * the first paint. Here the grammars people actually diff are imported
 * statically, so the whole set lives in the lazy diff chunk. Anything else
 * renders unhighlighted, which is what pierre does for unknown languages.
 */
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from '@shikijs/core';
import type { LanguageRegistration } from '@shikijs/core';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';
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

type Grammar = LanguageRegistration[];
const grammars: Record<string, Grammar> = {
    c, cpp, css, diff, dockerfile, go, graphql, html, ini, java, javascript, json, jsonc, jsx, kotlin, make,
    markdown, php, python, ruby, rust, scss, shellscript, sql, swift, toml, tsx, typescript, xml, yaml,
};
const entries = Object.entries(grammars).map(([id, grammar]) => [id, () => Promise.resolve({ default: grammar })] as const);
const aliases = Object.entries(grammars).flatMap(([id, grammar]) =>
    (grammar[grammar.length - 1]?.aliases ?? []).map((alias) => [alias, () => Promise.resolve({ default: grammars[id]! })] as const));
export const bundledLanguagesBase = Object.fromEntries(entries);
export const bundledLanguagesAlias = Object.fromEntries(aliases);
export const bundledLanguages = { ...bundledLanguagesBase, ...bundledLanguagesAlias };
export const bundledLanguagesInfo = Object.entries(grammars).map(([id, grammar]) => ({
    id, name: grammar[grammar.length - 1]?.displayName ?? id, aliases: grammar[grammar.length - 1]?.aliases, import: bundledLanguagesBase[id]!,
}));

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
