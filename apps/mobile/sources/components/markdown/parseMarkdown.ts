import { parseMarkdownBlock } from "./parseMarkdownBlock"


export function parseMarkdown(markdown: string) {
    return parseMarkdownBlock(markdown);
}
