/**
 * Decide whether a pull request only touches documentation or evidence, so the
 * CI jobs can skip their expensive steps while still reporting success as
 * required checks.
 *
 * Fail-open: an unknown/unresolvable base, a diff error, or any file that is
 * not clearly docs/evidence runs the whole lane. The one deliberate exception
 * is README.md and SKILL.md at any path: the product reads them (the CLI prints
 * SKILL.md; checkPackageSmoke.mjs asserts README.md content), so a change to
 * either must run the full lane even though its extension is `.md`.
 *
 * Usage: node scripts/diagnostics/application/scopeDocsOnly.mjs <base-sha>
 * Writes `docs_only=true|false` to $GITHUB_OUTPUT (stdout when unset).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const productRead = (file) => /(^|\/)(README|SKILL)\.md$/.test(file);
const docsOnlyPath = (file) => /\.(md|mdx)$/.test(file)
    || /^(docs\/|data\/|screenshots\/|LICENSE$|NOTICE$|TRADEMARK$)/.test(file);

/** True only when the diff from `base` to HEAD is entirely docs/evidence. */
export function scopeDocsOnly(base) {
    if (base === '') return false;
    try {
        execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'ignore' });
    } catch {
        return false;
    }
    let changed;
    try {
        changed = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' })
            .split('\n').filter(Boolean);
    } catch {
        return false;
    }
    return changed.every((file) => !productRead(file) && docsOnlyPath(file));
}

const emit = (docsOnly) => {
    const line = `docs_only=${docsOnly ? 'true' : 'false'}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
    else process.stdout.write(line);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    emit(scopeDocsOnly(process.argv[2] || ''));
}
