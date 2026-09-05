import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export async function reserveAndroidBuild() {
    // Fast-forward-only ledger updates arbitrate ALL builders, including retries.
    // No secrets or mutable repository variables are needed. A reservation is never reused.
    const repository = process.env.GITHUB_REPOSITORY;
    if (repository !== 'umeranjum17/muxr') throw new Error('Build numbering requires the canonical repository');
    const branch = 'release-build-numbers';
    function api(path, body) {
        const args = ['api', `repos/${repository}/${path}`];
        if (body !== undefined) args.push('--method', 'POST', '--input', '-');
        return JSON.parse(execFileSync('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    }
    let reserved;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        let parent;
        try { parent = api(`git/ref/heads/${branch}`).object.sha; }
        catch (cause) { if (!String(cause.stderr).includes('404')) throw cause; }
        let previous = 356;
        if (parent) {
            const file = api(`contents/android.json?ref=${parent}`);
            previous = JSON.parse(Buffer.from(file.content, 'base64').toString()).versionCode;
        }
        if (!Number.isSafeInteger(previous) || previous < 356 || previous >= 2100000000) throw new Error('Invalid Android build ledger');
        const versionCode = previous + 1;
        const content = JSON.stringify({ versionCode, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
        const tree = api('git/trees', { tree: [{ path: 'android.json', mode: '100644', type: 'blob', content }] });
        const commit = api('git/commits', { message: `Reserve Android build ${versionCode}`, tree: tree.sha, parents: parent ? [parent] : [] });
        try {
            if (parent) {
                execFileSync('gh', ['api', `repos/${repository}/git/refs/heads/${branch}`, '--method', 'PATCH', '--input', '-'], {
                    input: JSON.stringify({ sha: commit.sha, force: false }), stdio: ['pipe', 'pipe', 'pipe'],
                });
            } else api('git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
            reserved = versionCode;
            break;
        } catch (cause) { if (!/409|422/.test(String(cause.stderr))) throw cause; }
    }
    if (!reserved) throw new Error('Could not reserve an Android build number');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version_code=${reserved}\n`);
    process.stdout.write(`${reserved}\n`);
}
