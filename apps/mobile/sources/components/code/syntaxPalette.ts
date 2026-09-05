import type { Theme } from '@/theme';

/**
 * Which ink a Prism token type gets. A palette is passed in rather than read
 * from the theme because the reading surface is a dark panel whatever the app
 * theme is, while markdown renders code inline on the page.
 */
export interface SyntaxPalette {
    /** Identifiers and anything unclassified: the brightest ink on the panel. */
    text: string;
    /** Brackets, separators, operators - structure recedes so names stand. */
    dim: string;
    keyword: string;
    string: string;
    number: string;
    function: string;
    className: string;
    tag: string;
    comment: string;
}

export function codePalette(theme: Theme): SyntaxPalette {
    const c = theme.colors.code;
    return {
        text: c.text,
        dim: c.dim,
        keyword: c.keyword,
        string: c.string,
        number: c.number,
        function: c.function,
        className: c.className,
        tag: c.tag,
        comment: c.dim,
    };
}

/** The page palette, for code rendered inside prose rather than on the panel. */
export function pagePalette(theme: Theme): SyntaxPalette {
    return {
        text: theme.colors.syntaxDefault,
        dim: theme.colors.syntaxDefault,
        keyword: theme.colors.syntaxKeyword,
        string: theme.colors.syntaxString,
        number: theme.colors.syntaxNumber,
        function: theme.colors.syntaxFunction,
        className: theme.colors.syntaxKeyword,
        tag: theme.colors.syntaxKeyword,
        comment: theme.colors.syntaxComment,
    };
}

export function tokenColor(palette: SyntaxPalette, type: string | undefined): string {
    switch (type) {
        case 'comment': case 'prolog': case 'doctype': case 'cdata': return palette.comment;
        case 'string': case 'char': case 'regex': case 'attr-value': case 'template-string': return palette.string;
        case 'number': case 'boolean': case 'constant': case 'symbol': case 'property': case 'attr-name': return palette.number;
        case 'function': case 'method': case 'function-variable': return palette.function;
        case 'class-name': case 'builtin': case 'namespace': case 'maybe-class-name': return palette.className;
        case 'tag': case 'selector': return palette.tag;
        case 'keyword': case 'atrule': case 'important': case 'rule': return palette.keyword;
        case 'punctuation': case 'operator': return palette.dim;
        default: return palette.text;
    }
}
