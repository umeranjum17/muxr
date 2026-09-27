export function hostSoakOutcome(report, settledSamples, children) {
    if (report.unexpectedStreamEnds > 0 || children.some((child) => child.exitCode !== null || child.signal !== null)) return 'failed';
    if (report.minutes < 15) return 'inconclusive';
    return settledSamples >= 12 && report.terminalFrames > 100 && report.reconnectMs.length >= 1
        && report.hostRssDriftKb < 131072 ? 'pass' : 'failed';
}
