import React from 'react';
import { css, optical, type as scale } from './design';

/**
 * A flush-left headline, set line by line.
 *
 * `white-space: pre-line` on one element cannot be optically aligned: the left
 * side bearing belongs to the glyph, so a block whose lines start with O, T and
 * E presents three different left edges no matter what single offset you give
 * the box. Each line therefore gets its own element and its own correction, and
 * the block ends up with one edge — the one the eye reads.
 */
export const Headline: React.FC<{
    text: string;
    color: string;
    kind: 'film' | 'store';
}> = ({ text, color, kind }) => (
    <h1 style={{ ...css(scale[kind].display), color, textBoxTrim: 'trim-both', textBoxEdge: 'cap alphabetic' }}>
        {text.split('\n').map((line, i) => (
            <div key={i} style={{ marginLeft: optical(line) }}>
                {line}
            </div>
        ))}
    </h1>
);

/** Body copy takes the same treatment, one notch smaller, for the same reason. */
export const Body: React.FC<{
    text: string;
    color: string;
    kind: 'film' | 'store';
    marginTop?: number;
}> = ({ text, color, kind, marginTop }) => (
    <p style={{ ...css(scale[kind].body), color, marginTop }}>
        {text.split('\n').map((line, i) => (
            <div key={i} style={{ marginLeft: optical(line) + 4 }}>
                {line}
            </div>
        ))}
    </p>
);
