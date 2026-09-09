import { updateChannelCatalog } from '../application/updateChannelCatalog.mjs';

const option = (key) => {
    const index = process.argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    return process.argv[index + 1];
};
const tag = option('tag') ?? process.env.RELEASE_TAG;
const published = await updateChannelCatalog({ tag, verifyCatalog: !process.argv.includes('--no-verify') });
const state = published.changed ? 'now points at' : 'already pointed at';
process.stdout.write(`${published.channel} ${state} ${published.entry.version} (${published.entry.android.url})\n`);
