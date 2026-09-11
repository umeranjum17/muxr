import { verifyPublicRelease } from '../application/verifyPublicRelease.mjs';

const option = (key) => {
    const index = process.argv.indexOf(`--${key}`);
    if (index < 0) return undefined;
    return process.argv[index + 1];
};
const version = option('version') ?? process.env.RELEASE_VERSION;
const result = await verifyPublicRelease({
    tag: option('tag') ?? `v${version}`,
    version,
    ...(option('channel') === undefined ? {} : { channel: option('channel') }),
    ...(option('site') === undefined ? {} : { site: option('site') }),
});
process.stdout.write(`${result.channel} is public: ${result.version}, download redirects (${result.redirectStatus}) to ${result.apk}\n`);
