import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { distribution, releaseVersion } from '../domain/channel.mjs';

const STATUSES = ['passed', 'partial', 'failed', 'not-run'];
const STATUS_WORDS = { passed: 'Passed', partial: 'Partial', failed: 'Failed', 'not-run': 'Not run' };
const CHANGELOG = 'apps/mobile/sources/changelog/changelog.json';
export const reportFiles = { html: 'what-changed.html', markdown: 'release-notes.md' };

const plain = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[<>]/.test(value);
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
// Authored text is data, not markup. Collapsing whitespace removes every line
// start, so a heading, list or quote marker cannot begin one; escaping the
// inline-active punctuation removes links, images, emphasis, code and HTML.
// `-`, `+`, `.` and `)` go with them: a summary is rendered on a line of its
// own, so an authored "- item", "+ item", "---" or "1. item" would open a list
// or a thematic break there whatever the whitespace collapse did. `&` goes with
// them too: Markdown resolves entity references, so an authored "AT&amp;T"
// would be read back as "AT&T" instead of the text the author wrote.
const inline = (value) => String(value).replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>#!|~+\-.)&]/g, '\\$&');

function requireChange(change, where) {
    if (!change || !plain(change.title, 120) || !plain(change.detail, 600)) throw new Error(`${where} has a malformed change`);
}

/** Exactly one entry per app version; a missing entry never falls back to another. */
export function selectChangelogEntry(appVersion, sourceRoot = process.cwd()) {
    if (!/^\d+\.\d+\.\d+$/.test(String(appVersion))) throw new Error('Changelog selection needs an app version');
    const data = JSON.parse(readFileSync(join(sourceRoot, CHANGELOG), 'utf8'));
    if (!Array.isArray(data.releases)) throw new Error('Changelog has no releases');
    const matches = data.releases.filter((release) => release.appVersion === appVersion);
    if (matches.length === 0) throw new Error(`Changelog has no entry for app version ${appVersion}; add one before releasing`);
    if (matches.length > 1) throw new Error(`Changelog has ${matches.length} entries for app version ${appVersion}`);
    const entry = matches[0];
    const where = `Changelog ${appVersion}`;
    if (!plain(entry.title, 120) || !plain(entry.summary, 400)) throw new Error(`${where} needs a plain title and summary`);
    for (const key of ['features', 'fixes', 'verification']) {
        if (!Array.isArray(entry[key]) || entry[key].length > 24) throw new Error(`${where} has a malformed ${key} list`);
        for (const change of entry[key]) requireChange(change, where);
    }
    if (entry.features.length + entry.fixes.length === 0) throw new Error(`${where} records no changes`);
    for (const item of entry.verification) {
        if (!STATUSES.includes(item.status)) throw new Error(`${where} has an unknown verification status`);
        const evidence = item.evidence;
        if (evidence === undefined) continue;
        for (const field of ['testedCommit', 'environment', 'checkedBy', 'checkedAt']) {
            if (!plain(evidence[field], 200)) throw new Error(`${where} has malformed evidence`);
        }
        if (evidence.path !== undefined) {
            if (!/^[A-Za-z0-9._\-/]{1,200}$/.test(evidence.path) || evidence.path.includes('..')) throw new Error(`${where} has an unusable evidence path`);
            const path = join(sourceRoot, evidence.path);
            if (!existsSync(path)) throw new Error(`${where} references missing evidence ${evidence.path}`);
            if (evidence.sha256 !== undefined) {
                const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
                if (digest !== evidence.sha256) throw new Error(`${where} evidence digest mismatch for ${evidence.path}`);
            }
        }
    }
    if (!Array.isArray(entry.knownLimits) || entry.knownLimits.length > 24 || entry.knownLimits.some((limit) => !plain(limit, 400))) {
        throw new Error(`${where} has malformed known limits`);
    }
    return entry;
}

function metadata({ version, channel, commit, buildCode }) {
    const release = distribution(version, channel ?? releaseVersion(version).channel);
    return { ...release, commit, buildCode: buildCode === undefined ? undefined : String(buildCode) };
}

function markdownReport(entry, meta) {
    const lines = [`# muxr ${meta.version}`, '', `Changes for app version ${entry.appVersion} — ${inline(entry.title)}`, '', inline(entry.summary), '',
        `Channel: ${meta.channel}. Source: ${meta.commit}.${meta.buildCode ? ` Android build: ${meta.buildCode}.` : ''}`, ''];
    const section = (title, changes) => {
        if (changes.length === 0) return;
        lines.push(`## ${title}`, '');
        for (const change of changes) lines.push(`- **${inline(change.title)}** — ${inline(change.detail)}`);
        lines.push('');
    };
    section('Added', entry.features);
    section('Fixed', entry.fixes);
    lines.push('## Verification', '');
    if (entry.verification.length === 0) lines.push('No verification recorded.', '');
    else {
        for (const item of entry.verification) {
            const evidence = item.evidence;
            const trail = evidence ? ` _(${inline([evidence.environment, evidence.testedCommit, evidence.checkedBy, evidence.checkedAt, evidence.path].filter(Boolean).join(' · '))})_` : '';
            lines.push(`- **${STATUS_WORDS[item.status]} · ${inline(item.title)}** — ${inline(item.detail)}${trail}`);
        }
        lines.push('');
    }
    lines.push('## Known limits', '');
    if (entry.knownLimits.length === 0) lines.push('No additional limits recorded.', '');
    else {
        for (const limit of entry.knownLimits) lines.push(`- ${inline(limit)}`);
        lines.push('');
    }
    lines.push('Release candidate; **not production**. A successful build is not device acceptance.', '',
        meta.channel === 'nightly'
            ? 'The nightly app installs separately, keeps its own data and uses manual self-host pairing.'
            : 'This updates the existing direct-install muxr app; it shares its data.', '',
        'The npm tarball can be installed directly with npm. Registry publication uses the separate verified publisher. Production promotion is manual.', '');
    return lines.join('\n');
}

const STYLE = `:root{color-scheme:light dark;--surface:#ffffff;--card:#f8f8f8;--text:#17171a;--muted:#5b5b61;--border:#e4e4e7}
@media (prefers-color-scheme:dark){:root{--surface:#101012;--card:#17171a;--text:#ececec;--muted:#a1a1a6;--border:#2a2a2e}}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px;background:var(--surface);color:var(--text);line-height:1.6;
font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto}
header{border-bottom:1px solid var(--border);padding-bottom:20px;margin-bottom:24px}
.brand{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:baseline;font-size:14px;color:var(--muted)}
.wordmark{font-weight:600;letter-spacing:-0.02em;color:var(--text);font-size:18px}
h1{font-size:28px;line-height:1.25;margin:16px 0 8px;letter-spacing:-0.01em}
h2{font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
p{margin:0 0 12px}
.summary{font-size:17px;color:var(--muted);margin:0}
.meta{margin-top:12px;font-size:14px;color:var(--muted);overflow-wrap:anywhere}
.columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media (max-width:720px){.columns{grid-template-columns:1fr}}
section{margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px}
.item{margin-bottom:14px}
.item:last-child{margin-bottom:0}
.item-title{font-weight:600;margin:0 0 2px}
.item-detail{margin:0;color:var(--muted)}
.evidence{margin:4px 0 0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
ul{margin:0;padding-left:20px;color:var(--muted)}
li{margin-bottom:6px}
footer{border-top:1px solid var(--border);padding-top:16px;font-size:14px;color:var(--muted);overflow-wrap:anywhere}
a{color:inherit}
a:focus-visible,:focus-visible{outline:2px solid currentColor;outline-offset:2px}`;

function htmlReport(entry, meta) {
    const items = (changes) => changes.map((change) =>
        `      <div class="item"><p class="item-title">${escape(change.title)}</p><p class="item-detail">${escape(change.detail)}</p></div>`).join('\n');
    const column = (title, changes) => changes.length === 0 ? '' :
        `    <section>\n      <h2>${escape(title)}</h2>\n      <div class="card">\n${items(changes)}\n      </div>\n    </section>`;
    const verification = entry.verification.length === 0
        ? '        <p class="item-detail">No verification recorded.</p>'
        : entry.verification.map((item) => {
            const evidence = item.evidence;
            const trail = evidence
                ? `<p class="evidence">${escape([evidence.environment, evidence.testedCommit, evidence.checkedBy, evidence.checkedAt, evidence.path].filter(Boolean).join(' · '))}</p>`
                : '';
            return `        <div class="item"><p class="item-title">${escape(`${STATUS_WORDS[item.status]} · ${item.title}`)}</p><p class="item-detail">${escape(item.detail)}</p>${trail}</div>`;
        }).join('\n');
    const limits = entry.knownLimits.length === 0
        ? '        <p class="item-detail">No additional limits recorded.</p>'
        : `        <ul>\n${entry.knownLimits.map((limit) => `          <li>${escape(limit)}</li>`).join('\n')}\n        </ul>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(`muxr ${meta.version} — what changed`)}</title>
<style>
${STYLE}
</style>
</head>
<body>
  <main>
    <header>
      <div class="brand"><span class="wordmark">muxr</span><span>${escape(`${meta.channel.toUpperCase()} · CANDIDATE`)}</span></div>
      <h1>${escape(entry.title)}</h1>
      <p class="summary">${escape(entry.summary)}</p>
      <p class="meta">${escape(`Changes for app version ${entry.appVersion} · release ${meta.version}`)}</p>
    </header>
    <div class="columns">
${column('Added', entry.features)}
${column('Fixed', entry.fixes)}
    </div>
    <section>
      <h2>Verification</h2>
      <div class="card">
${verification}
      </div>
    </section>
    <section>
      <h2>Known limits</h2>
      <div class="card">
${limits}
      </div>
    </section>
    <footer>
      <p>${escape(`Source ${meta.commit}${meta.buildCode ? ` · Android build ${meta.buildCode}` : ''} · channel ${meta.channel}`)}</p>
      <p>Release candidate; not production. A successful build is not device acceptance.</p>
    </footer>
  </main>
</body>
</html>
`;
}

/**
 * validate: entry only. generate: write both files. check: fail on missing or stale bytes.
 * Deterministic: no wall-clock time and no local paths enter the output.
 */
export function prepareChangelog({ mode = 'generate', appVersion, version, channel, commit, buildCode, directory, sourceRoot = process.cwd() }) {
    const meta = metadata({ version, channel, commit, buildCode });
    const selected = appVersion ?? meta.appVersion;
    if (selected !== meta.appVersion) throw new Error(`Selected app version ${selected} does not match release ${version}`);
    if (!/^[0-9a-f]{7,40}$/.test(String(commit))) throw new Error('Report needs the exact source commit');
    const entry = selectChangelogEntry(selected, sourceRoot);
    if (mode === 'validate') return { entry, files: {} };
    const rendered = { [reportFiles.html]: htmlReport(entry, meta), [reportFiles.markdown]: markdownReport(entry, meta) };
    for (const [name, content] of Object.entries(rendered)) {
        const path = join(directory, name);
        if (mode === 'check') {
            if (!existsSync(path)) throw new Error(`${name} is missing; generate it before sealing`);
            if (readFileSync(path, 'utf8') !== content) throw new Error(`${name} does not match the current source; it is stale`);
        } else {
            writeFileSync(path, content);
        }
    }
    return { entry, files: rendered };
}
