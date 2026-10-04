/**
 * Diff-scoped enforcement of the CONSTRAINTS.md floor: new checker
 * suppressions, unimplemented stubs / empty catches, unexplained skipped or
 * deleted tests, and weakened constraints. Adapted from the
 * constraint-driven-development floor-guard reference; the contract is
 * unchanged:
 *
 *   exit 0  clean
 *   exit 1  at least one floor violation
 *   exit 2  the guard could not run (not a git tree, no merge base)
 *
 * The diff covers tracked, staged and untracked changes between the merge
 * base and the working tree, so new files cannot slip past it. Findings name
 * the rule, path and line only -- never matched text, so a finding can never
 * quote a secret or suppressed line into a log.
 *
 * ponytail: deliberately regex-shallow (single-line patterns, range-wide
 * commit-message explanation for test diets). It catches the cheap-road-to-green
 * moves agents actually make, not a determined human hiding a change.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (() => {
    const i = process.argv.indexOf('--base');
    return i > -1 ? process.argv[i + 1] : 'origin/main';
})();

// `git diff --no-index` exits 1 whenever the two sides differ, which is the
// normal case for a new file, so that output is kept. Any other failure is
// null, and null never reads as clean.
const git = (args, { diffExit = false } = {}) => {
    try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return diffExit && e.status === 1 && typeof e.stdout === 'string' ? e.stdout : null; }
};
const bail = (msg) => { console.error('floor-guard: ' + msg); process.exit(2); };

// Run from the top of the work tree. `git ls-files` lists only the current
// directory's subtree, so a guard started in a subfolder would miss untracked
// files elsewhere and name the rest differently from `git diff`.
const top = git(['rev-parse', '--show-toplevel'])?.trim();
if (!top) bail('not inside a git work tree');
process.chdir(top);

const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
if (!mergeBase) bail('no merge base against ' + base);

const tracked = git(['diff', '--unified=0', mergeBase, '--']);
if (tracked === null) bail('could not diff against ' + mergeBase);
const untrackedFiles = git(['ls-files', '--others', '--exclude-standard']);
if (untrackedFiles === null) bail('could not list untracked files');
const untracked = untrackedFiles.split('\n').filter(Boolean).map((f) => {
    const d = git(['diff', '--no-index', '--unified=0', '/dev/null', f], { diffExit: true });
    if (d === null) bail('could not diff untracked file ' + f);
    return d;
}).join('\n');
const diff = tracked + '\n' + untracked;

// Walk the diff, keeping each line's number from its hunk header so findings
// can point at a place instead of quoting content. `---` and `+++` are file
// headers only between a file's `diff` line and its first `@@` hunk; inside a
// hunk every line is content, so an added `++i` (shown as `+++i`) is a change.
const added = [], removed = [], deleted = [];
// `--no-index` labels its sides 1/ and 2/, and a global diff.mnemonicPrefix
// config renders the sides i/ (index), w/ (worktree), c/ and o/ (commits)
// instead of a/ and b/; strip every form or path matching silently fails.
const pathOf = (s) => s.replace(/^[abciow12]\//, '');
let file = '', oldFile = '', inHeader = false, addLine = 0, remLine = 0;
for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) inHeader = true;
    else if (line.startsWith('@@')) {
        inHeader = false;
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        remLine = m ? Number(m[1]) : 0;
        addLine = m ? Number(m[2]) : 0;
    }
    else if (inHeader) {
        if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4));
        else if (line.startsWith('+++ ')) {
            const newFile = pathOf(line.slice(4));
            file = newFile === '/dev/null' ? oldFile : newFile;
            if (newFile === '/dev/null') deleted.push(file);
        }
    }
    else if (line.startsWith('+')) added.push({ file, line: addLine++, text: line.slice(1) });
    else if (line.startsWith('-')) removed.push({ file, line: remLine++, text: line.slice(1) });
}

const findings = [];
const flag = (rule, f, n) => findings.push({ rule, file: f, line: n });
const isTest = (f) => /\.(test|spec)\.|_test\.|test_|selfcheck\./i.test(f)
    || /^scripts\/diagnostics\/application\/(?:check[^/]*|runSkeletonCheck)\.(?:mjs|sh)$/.test(f)
    || f === 'packages/checkArchitecture.mjs';
const isConstraints = (f) => /CONSTRAINTS\.md$/.test(f);
// Documentation (and this guard itself) must be able to name what the floor
// bans without tripping it; a suppression that works has to live in code.
const selfPath = relative(top, fileURLToPath(import.meta.url));
const isDoc = (f) => /\.md$/i.test(f) || f === selfPath;

// 1. Silenced checker.
const SUPPRESSIONS = /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/;
// 4. Unfinished work: not-implemented throws and single-line empty catches.
const STUBS = /throw new (Error|NotImplemented)[^\n]*[Nn]ot implemented/;
const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*\}/s;
// 2. A test made easier (added skips).
const SKIPS = /\.(skip|todo)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(/;

const logBodies = git(['log', '--format=%B', `${mergeBase}..HEAD`]) ?? '';
const testChangeExplained = /\b(?:skip(?:ped|ping)?|delet(?:e|ed|ing|ion)|remov(?:e|ed|ing|al))\b[^\n]*\b(?:because|since|due to|until|in favor of|in favour of|to avoid)\s+\S|^\s*reason:[^\n]*\b(?:because|since|due to|until|in favor of|in favour of|to avoid)\s+\S/im.test(logBodies);
const SECURITY = /secur|crypt|e2ee|secret|credential|pairing|rotat|revoc|privacy|data.?loss|\bauth\b|authenticat|authoriz|authoris/i;
const removedTextsOf = (f) => removed.filter((r) => r.file === f).map((r) => r.text);
const isSecurityTest = (f, texts) => SECURITY.test(f) || texts.some((t) => SECURITY.test(t))
    || (existsSync(f) && SECURITY.test(readFileSync(f, 'utf8')));

for (const { file: f, line: n, text } of added) {
    if (!isDoc(f)) {
        if (SUPPRESSIONS.test(text)) flag('silenced-checker', f, n);
        if (STUBS.test(text)) flag('unfinished-work', f, n);
        if (SKIPS.test(text) && isTest(f) && (isSecurityTest(f, removedTextsOf(f)) || !testChangeExplained)) {
            flag('test-made-easier', f, n);
        }
    }
    if (isConstraints(f) && /^\| *(W|E)\d+ *\|/.test(text)) flag('new-exception', f, n);
}

const addedByFile = new Map();
for (const a of added) {
    if (!addedByFile.has(a.file)) addedByFile.set(a.file, []);
    addedByFile.get(a.file).push(a);
}
for (const [f, entries] of addedByFile) {
    if (isDoc(f)) continue;
    if (EMPTY_CATCH.test(entries.map((e) => e.text).join('\n'))) flag('unfinished-work', f, entries[0].line);
}

for (const f of deleted) {
    if (!isTest(f)) continue;
    if (isSecurityTest(f, removedTextsOf(f)) || !testChangeExplained) flag('test-deleted', f, 1);
}

for (const { file: f, line: n, text } of removed) {
    if (isDoc(f) || !isTest(f) || deleted.includes(f)) continue;
    if (/\b(expect|assert|should)\b|(?:^|[^\w$])check\s*\(|(?:^|[^\w$])fail\s*\(|\bthrow\s+new\s+Error\b/.test(text)) flag('assertion-removed', f, n);
}

// 1b/2c. A rule in CONSTRAINTS.md weakened or removed. A rule is a floor
// bullet or a table row, identified by the bullet's text before its first
// colon or by the row's first cell. Each number carries a direction read from
// the words around it: a minimum is loosened by going down, a maximum by going
// up. A number whose direction cannot be read is reported whenever it
// changes, because the guard cannot tell tightening from loosening and
// staying quiet is the wrong default.
const ruleKey = (t) => {
    const s = t.trim();
    if (s.startsWith('|')) return '|' + (s.split('|').map((c) => c.trim()).filter(Boolean)[0] ?? '');
    if (/^[-*] /.test(s)) return s.slice(2).split(':')[0].trim();
    return null; // prose, headings, dates: not a rule
};
const isException = (t) => /^\| *(W|E)\d+ *\|/.test(t.trim());
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/;
const MAX_BEFORE = /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed)\s*$/;
const MIN_AFTER = /^\s*\S*\s*(or more|or higher|must not fall|must not drop)/;
const MAX_AFTER = /^\s*\S*\s*(or less|or lower|must not grow|must not exceed)/;
const thresholds = (t) => {
    const out = [], re = /\d+(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(t))) {
        const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
        const dir = MIN_BEFORE.test(before) || MIN_AFTER.test(after) ? 'min'
            : MAX_BEFORE.test(before) || MAX_AFTER.test(after) ? 'max' : null;
        out.push({ n: Number(m[0]), dir });
    }
    return out;
};
const rulesOf = (file, content) => {
    const rules = [];
    let rule = null;
    for (const [i, text] of content.split('\n').entries()) {
        if (ruleKey(text) !== null) {
            rule = { file, line: i + 1, key: ruleKey(text), text };
            rules.push(rule);
        }
        else if (rule && /^\s+\S/.test(text)) rule.text += ' ' + text.trim();
        else rule = null;
    }
    return rules;
};
const constraintFiles = new Set([...removed, ...added].filter((l) => isConstraints(l.file)).map((l) => l.file));
const removedRules = [], addedRules = [];
for (const f of constraintFiles) {
    const before = git(['show', `${mergeBase}:${f}`]);
    if (before !== null) removedRules.push(...rulesOf(f, before));
    if (existsSync(f)) addedRules.push(...rulesOf(f, readFileSync(f, 'utf8')));
}
const qualitativeRule = (text) => text.replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
const qualitativePreserved = (before, after) => {
    if (qualitativeRule(before) === qualitativeRule(after)) return true;
    const list = /^(.*\bNo\b[^:|]*(?::|\|))\s*(`[^`]+`(?:\s*,\s*`[^`]+`)*)(.*)$/i;
    const was = before.match(list), now = after.match(list);
    if (!was || !now) return false;
    if (was[1] !== now[1] || was[3] !== now[3]) return false;
    const forbidden = new Set(now[2].match(/`[^`]+`/g));
    return was[2].match(/`[^`]+`/g).every((item) => forbidden.has(item));
};
for (const r of removedRules) {
    const a = addedRules.find((x) => x.file === r.file && x.key === r.key);
    if (!a) {
        if (!isException(r.text)) flag('rule-removed', r.file, r.line); // dropping an exception tightens: silent
        continue;
    }
    const before = thresholds(r.text), after = thresholds(a.text);
    let verdict = qualitativePreserved(r.text, a.text) ? null : 'rule-changed';
    for (const dir of ['min', 'max', null]) {
        const was = before.filter((x) => x.dir === dir), now = after.filter((x) => x.dir === dir);
        was.forEach((b, i) => {
            const n = now[i];
            if (verdict) return;
            if (!n) verdict = 'threshold-removed';
            else if (n.n === b.n) return;
            else if (dir === 'min' ? n.n < b.n : dir === 'max' ? n.n > b.n : true) {
                verdict = dir ? 'threshold-loosened' : 'threshold-changed';
            }
        });
    }
    if (verdict) flag(verdict, r.file, `${r.line}->${a.line}`);
}

if (findings.length === 0) { console.log(`floor-guard: clean (base ${mergeBase.slice(0, 12)}, ${added.length} added / ${removed.length} removed lines)`); process.exit(0); }
console.error('floor-guard: ' + findings.length + ' floor violation(s):');
for (const f of findings) console.error(`  [${f.rule}] ${f.file}:${f.line}`);
if (findings.some((f) => f.rule === 'rule-removed')) {
    console.error('\nA rule-removed finding can also mean the rule\'s label changed: rename a rule in one commit and change its thresholds in another.');
}
if (findings.some((f) => f.rule === 'threshold-removed')) {
    console.error('\nA threshold-removed finding can also mean a number gained or lost its direction words (">= 80%" becoming "80%", or the reverse): compare the two lines before assuming a threshold was deleted.');
}
if (findings.some((f) => f.rule === 'test-deleted' || f.rule === 'test-made-easier')) {
    console.error('\nSkipped or deleted tests require a reason in a commit in range; security, crypto and data-loss coverage must remain.');
}
console.error('\nEach is a move that lowers the bar. Fix the change, or put the reason in the commit message.');
process.exit(1);
