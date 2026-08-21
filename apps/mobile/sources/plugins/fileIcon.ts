/**
 * File-type icons for the plugin explorer, keyed by extension the way editors
 * do it. The glyph carries the type; the language's brand hue does not come
 * with it. Sixty brand colours in one tree is the look of a 2016 IDE, and it
 * spends colour on nothing the reader has to act on.
 */

import type { MaterialCommunityIcons } from '@expo/vector-icons';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export interface FileIcon {
    name: IconName;
}

const BY_EXTENSION: Record<string, FileIcon> = {
    ts: { name: 'language-typescript' },
    tsx: { name: 'language-typescript' },
    js: { name: 'language-javascript' },
    jsx: { name: 'language-javascript' },
    mjs: { name: 'language-javascript' },
    cjs: { name: 'language-javascript' },
    json: { name: 'code-json' },
    py: { name: 'language-python' },
    rs: { name: 'language-rust' },
    go: { name: 'language-go' },
    java: { name: 'language-java' },
    kt: { name: 'language-kotlin' },
    kts: { name: 'language-kotlin' },
    swift: { name: 'language-swift' },
    c: { name: 'language-c' },
    h: { name: 'language-c' },
    cc: { name: 'language-cpp' },
    cpp: { name: 'language-cpp' },
    hpp: { name: 'language-cpp' },
    rb: { name: 'language-ruby' },
    php: { name: 'language-php' },
    html: { name: 'language-html5' },
    css: { name: 'language-css3' },
    scss: { name: 'language-css3' },
    sh: { name: 'console' },
    bash: { name: 'console' },
    zsh: { name: 'console' },
    fish: { name: 'console' },
    md: { name: 'language-markdown' },
    mdx: { name: 'language-markdown' },
    yml: { name: 'cog-outline' },
    yaml: { name: 'cog-outline' },
    toml: { name: 'cog-outline' },
    ini: { name: 'cog-outline' },
    env: { name: 'key-variant' },
    lock: { name: 'lock-outline' },
    sql: { name: 'database-outline' },
    png: { name: 'file-image-outline' },
    jpg: { name: 'file-image-outline' },
    jpeg: { name: 'file-image-outline' },
    gif: { name: 'file-image-outline' },
    webp: { name: 'file-image-outline' },
    svg: { name: 'svg' },
    ico: { name: 'file-image-outline' },
    mp4: { name: 'file-video-outline' },
    mov: { name: 'file-video-outline' },
    webm: { name: 'file-video-outline' },
    mp3: { name: 'file-music-outline' },
    wav: { name: 'file-music-outline' },
    pdf: { name: 'file-pdf-box' },
    zip: { name: 'folder-zip-outline' },
    gz: { name: 'folder-zip-outline' },
    tar: { name: 'folder-zip-outline' },
};

const BY_NAME: Record<string, FileIcon> = {
    '.gitignore': { name: 'git' },
    '.gitattributes': { name: 'git' },
    '.gitmodules': { name: 'git' },
    dockerfile: { name: 'docker' },
    'docker-compose.yml': { name: 'docker' },
    'package.json': { name: 'npm' },
    'yarn.lock': { name: 'lock-outline' },
    'package-lock.json': { name: 'lock-outline' },
    makefile: { name: 'cog-outline' },
    license: { name: 'scale-balance' },
};

export function fileIcon(name: string): FileIcon {
    const lower = name.toLowerCase();
    const named = BY_NAME[lower];
    if (named !== undefined) return named;
    const dot = lower.lastIndexOf('.');
    const extension = dot <= 0 ? '' : lower.slice(dot + 1);
    return BY_EXTENSION[extension] ?? { name: 'file-outline' };
}

export function folderIcon(expanded: boolean): FileIcon {
    return { name: expanded ? 'folder-open' : 'folder' };
}
