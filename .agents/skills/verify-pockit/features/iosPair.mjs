// Pair a running private host to an iOS simulator: the same pair.sock flow as
// `muxr pair`, with the offer written as the link `xcrun simctl openurl` takes.
// Usage (repo root, the host's MUXR_HOME, a file for the link):
//   node .agents/skills/verify-pockit/features/iosPair.mjs <MUXR_HOME> <link-file>
// Exit 0 once the host reports the pairing result; the link file holds
// `muxr://pair#<offer>`. Approval words and the device id are printed for the evidence.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pairOnRunningHost } from '../../../../scripts/setup/application/linkPair.mjs';

const [home, linkFile] = process.argv.slice(2);
if (!home || !linkFile) {
    process.stderr.write('usage: iosPair.mjs <MUXR_HOME> <link-file>\n');
    process.exit(2);
}

const result = await pairOnRunningHost(
    join(home, 'host', 'pair.sock'),
    async (approval) => {
        process.stdout.write(`approval words: ${approval.words}\n`);
        return true;
    },
    undefined,
    undefined,
    async (offer) => {
        writeFileSync(linkFile, `muxr://pair#${offer.text}\n`, { mode: 0o600 });
        process.stdout.write(`offer written to ${linkFile}\n`);
    },
);

if (!result) {
    process.stderr.write('pairing ended without a result\n');
    process.exit(1);
}
process.stdout.write(`paired: ${result.deviceId}\n`);
