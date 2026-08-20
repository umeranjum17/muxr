/**
 * File-type icons for the plugin explorer, keyed by extension the way editors
 * do it. Colours are the language's own so a long tree is scannable without
 * reading a single name.
 */

import type { MaterialCommunityIcons } from '@expo/vector-icons';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export interface FileIcon {
    name: IconName;
    color?: string;
}

const BY_EXTENSION: Record<string, FileIcon> = {
    ts: { name: 'language-typescript', color: '#3178c6' },
    tsx: { name: 'language-typescript', color: '#3178c6' },
    js: { name: 'language-javascript', color: '#f1e05a' },
    jsx: { name: 'language-javascript', color: '#f1e05a' },
    mjs: { name: 'language-javascript', color: '#f1e05a' },
    cjs: { name: 'language-javascript', color: '#f1e05a' },
    json: { name: 'code-json', color: '#cbcb41' },
    py: { name: 'language-python', color: '#4b8bbe' },
    rs: { name: 'language-rust', color: '#dea584' },
    go: { name: 'language-go', color: '#00add8' },
    java: { name: 'language-java', color: '#b07219' },
    kt: { name: 'language-kotlin', color: '#a97bff' },
    kts: { name: 'language-kotlin', color: '#a97bff' },
    swift: { name: 'language-swift', color: '#f05138' },
    c: { name: 'language-c', color: '#8ab4f8' },
    h: { name: 'language-c', color: '#8ab4f8' },
    cc: { name: 'language-cpp', color: '#f34b7d' },
    cpp: { name: 'language-cpp', color: '#f34b7d' },
    hpp: { name: 'language-cpp', color: '#f34b7d' },
    rb: { name: 'language-ruby', color: '#cc342d' },
    php: { name: 'language-php', color: '#8993be' },
    html: { name: 'language-html5', color: '#e34c26' },
    css: { name: 'language-css3', color: '#8f7ddb' },
    scss: { name: 'language-css3', color: '#cf649a' },
    sh: { name: 'console', color: '#89e051' },
    bash: { name: 'console', color: '#89e051' },
    zsh: { name: 'console', color: '#89e051' },
    fish: { name: 'console', color: '#89e051' },
    md: { name: 'language-markdown', color: '#8ab4f8' },
    mdx: { name: 'language-markdown', color: '#8ab4f8' },
    yml: { name: 'cog-outline', color: '#e6a44e' },
    yaml: { name: 'cog-outline', color: '#e6a44e' },
    toml: { name: 'cog-outline', color: '#e6a44e' },
    ini: { name: 'cog-outline', color: '#e6a44e' },
    env: { name: 'key-variant', color: '#e6a44e' },
    lock: { name: 'lock-outline', color: '#8a8f98' },
    sql: { name: 'database-outline', color: '#e38c00' },
    png: { name: 'file-image-outline', color: '#a074c4' },
    jpg: { name: 'file-image-outline', color: '#a074c4' },
    jpeg: { name: 'file-image-outline', color: '#a074c4' },
    gif: { name: 'file-image-outline', color: '#a074c4' },
    webp: { name: 'file-image-outline', color: '#a074c4' },
    svg: { name: 'svg', color: '#ffb13b' },
    ico: { name: 'file-image-outline', color: '#a074c4' },
    mp4: { name: 'file-video-outline', color: '#8ab4f8' },
    mov: { name: 'file-video-outline', color: '#8ab4f8' },
    webm: { name: 'file-video-outline', color: '#8ab4f8' },
    mp3: { name: 'file-music-outline', color: '#8ab4f8' },
    wav: { name: 'file-music-outline', color: '#8ab4f8' },
    pdf: { name: 'file-pdf-box', color: '#e05a4e' },
    zip: { name: 'folder-zip-outline', color: '#e6a44e' },
    gz: { name: 'folder-zip-outline', color: '#e6a44e' },
    tar: { name: 'folder-zip-outline', color: '#e6a44e' },
};

const BY_NAME: Record<string, FileIcon> = {
    '.gitignore': { name: 'git', color: '#f14e32' },
    '.gitattributes': { name: 'git', color: '#f14e32' },
    '.gitmodules': { name: 'git', color: '#f14e32' },
    dockerfile: { name: 'docker', color: '#2496ed' },
    'docker-compose.yml': { name: 'docker', color: '#2496ed' },
    'package.json': { name: 'npm', color: '#cb3837' },
    'yarn.lock': { name: 'lock-outline', color: '#8a8f98' },
    'package-lock.json': { name: 'lock-outline', color: '#8a8f98' },
    makefile: { name: 'cog-outline', color: '#e6a44e' },
    license: { name: 'scale-balance', color: '#8a8f98' },
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
    return { name: expanded ? 'folder-open' : 'folder', color: '#7aa2d6' };
}
