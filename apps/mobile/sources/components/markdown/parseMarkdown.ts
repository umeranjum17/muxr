import { parseMarkdownBlock } from "@/components/markdown/parseMarkdownBlock"


export function parseMarkdown(markdown: string) {
    return parseMarkdownBlock(markdown);
}
