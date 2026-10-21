import { checkJourneyReceipt } from '../application/checkJourneyReceipt.mjs';

const option = (key) => {
    const index = process.argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    return process.argv[index + 1];
};
const journey = option('journey') ?? 'phone-attach';
const commit = option('commit') ?? process.env.RELEASE_COMMIT ?? 'HEAD';
const receiptsRef = option('receipts') ?? process.env.RELEASE_RECEIPTS_REF ?? 'origin/main';
const result = checkJourneyReceipt({ commit, receiptsRef, journey });
if (result.ok) {
    process.stdout.write(`the ${journey} receipt ${result.path} proves ${result.receipt.head.slice(0, 12)}\n`);
} else {
    process.stderr.write(`the release has no ${journey} proof:\n${result.reason}\n`);
    process.exitCode = 1;
}
