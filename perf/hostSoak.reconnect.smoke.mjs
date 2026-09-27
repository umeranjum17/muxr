import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const scratch = mkdtempSync(join(process.cwd(), 'perf', '.soak-reconnect-'));
try {
    const reportPath = join(scratch, 'report.json');
    execFileSync(process.execPath, ['perf/hostSoak.mjs', '--minutes', '2', '--out', reportPath], { stdio: 'pipe', maxBuffer: 2 * 1024 * 1024 });
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.outcome, 'inconclusive');
    assert.ok(report.reconnectMs.length > 0, 'the paired grant must reconnect the device');
    assert.equal(report.unexpectedStreamEnds, 0, 'deliberate reconnect must not count as stream loss');
    assert.ok(report.terminalFrames > 100, 'the new link must continue streaming terminal frames');
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
