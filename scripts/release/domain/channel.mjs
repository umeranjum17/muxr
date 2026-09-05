/** Distribution channel is independent of server environment and app identity. */
export const channelTags = Object.freeze({ dev: 'dev', beta: 'beta', stable: 'latest' });

export function releaseVersion(version) {
    if (typeof version !== 'string' || version.length > 120) throw new Error('Invalid release version');
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/.exec(version);
    if (!match || match.slice(1, 4).some((value) => !Number.isSafeInteger(Number(value)))) throw new Error('Invalid release version');
    const prerelease = match[4];
    if (prerelease?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error('Invalid prerelease number');
    let channel = 'stable';
    if (prerelease !== undefined) channel = /^(dev|nightly)(\.|-|$)/.test(prerelease) ? 'dev' : 'beta';
    return { version, appVersion: match.slice(1, 4).join('.'), channel };
}

export function releaseChannel(channel) {
    if (typeof channel !== 'string' || !Object.hasOwn(channelTags, channel)) throw new Error('Channel must be dev, beta or stable');
    return channel;
}

export function distribution(version, channel = releaseVersion(version).channel) {
    const result = releaseVersion(version);
    if (result.channel !== releaseChannel(channel)) throw new Error('Version does not belong to the requested release channel');
    return { ...result, distTag: channelTags[channel] };
}

export function compareVersions(left, right) {
    const parse = (value) => {
        const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
        return match && { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') };
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) return undefined;
    for (let index = 0; index < 3; index += 1) {
        if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
    }
    if (a.prerelease === undefined && b.prerelease === undefined) return 0;
    if (a.prerelease === undefined) return 1;
    if (b.prerelease === undefined) return -1;
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftIdentifier = a.prerelease[index];
        const rightIdentifier = b.prerelease[index];
        if (leftIdentifier === rightIdentifier) continue;
        if (leftIdentifier === undefined) return -1;
        if (rightIdentifier === undefined) return 1;
        const leftNumeric = /^\d+$/.test(leftIdentifier);
        const rightNumeric = /^\d+$/.test(rightIdentifier);
        if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    return 0;
}

