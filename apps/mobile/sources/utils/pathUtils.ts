import { Metadata } from '@/catalog';

/**
 * Resolves a path relative to the root path from metadata.
 * ALL paths are treated as relative to the metadata root, regardless of their format.
 * If metadata is not provided, returns the original path.
 * 
 * @param path - The path to resolve (always treated as relative to the metadata root)
 * @param metadata - Optional metadata containing the root path
 * @returns The resolved absolute path
 */
export function resolvePath(path: string, metadata: Metadata | null): string {
    if (!metadata) {
        return path;
    }
    if (path.toLowerCase().startsWith(metadata.path.toLowerCase())) {
        // Check that the path is actually within the metadata path by ensuring
        // there's either an exact match or a path separator after the metadata path
        const remainder = path.slice(metadata.path.length);
        if (remainder === '' || remainder.startsWith('/')) {
            let out = remainder;
            if (out.startsWith('/')) {
                out = out.slice(1);
            }
            if (out === '') {
                return '<root>';
            }
            return out;
        }
    }
    return path;
}

/** Shell that lists candidate project directories: top-level dirs plus nested repo roots. */
export const LIST_PROJECT_DIRS_COMMAND =
    `ls -d "$HOME"/*/ 2>/dev/null; find "$HOME" -mindepth 3 -maxdepth 3 -type d -name .git 2>/dev/null`;

/**
 * Parses LIST_PROJECT_DIRS_COMMAND output into deduped absolute directory paths.
 * `find` prints the .git dir itself (no -printf: that flag is GNU-only, hosts run macOS too).
 */
export function parseProjectDirs(stdout: string): string[] {
    const dirs = new Set<string>();
    for (const line of stdout.split('\n')) {
        const path = line.trim().replace(/\/+$/, '').replace(/\/\.git$/, '');
        if (path.startsWith('/')) {
            dirs.add(path);
        }
    }
    return [...dirs].sort();
}

/**
 * Resolves paths starting with ~ to absolute paths using the provided home directory.
 * Non-tilde paths are returned unchanged.
 * 
 * @param path - The path to resolve (may start with ~)
 * @param homeDir - The user's home directory (e.g., '/Users/steve' or 'C:\Users\steve')
 * @returns The resolved absolute path
 */
export function resolveAbsolutePath(path: string, homeDir?: string): string {
    // Return original path if it doesn't start with ~
    if (!path.startsWith('~')) {
        return path;
    }
    
    // Return original path if no home directory provided
    if (!homeDir) {
        return path;
    }
    
    // Handle exact ~ (home directory)
    if (path === '~') {
        // Remove trailing separator for consistency
        return homeDir.endsWith('/') || homeDir.endsWith('\\') 
            ? homeDir.slice(0, -1) 
            : homeDir;
    }
    
    // Handle ~/ and ~/path (home directory with subdirectory)
    if (path.startsWith('~/')) {
        const relativePart = path.slice(2); // Remove '~/'
        // Detect path separator based on homeDir - prefer the last separator found
        const hasBackslash = homeDir.lastIndexOf('\\') > homeDir.lastIndexOf('/');
        const separator = hasBackslash ? '\\' : '/';
        const normalizedHome = homeDir.endsWith('/') || homeDir.endsWith('\\') 
            ? homeDir.slice(0, -1) 
            : homeDir;
        return normalizedHome + separator + relativePart;
    }
    
    // Handle ~username paths (not supported, return original)
    return path;
}