import type { ServerResponse } from 'node:http';
import { drawing, escapeHtml, INSTALL, term, writeHtml, writeMessage } from './website.js';
import {
    apkFilename,
    linuxFilename,
    CHANNELS,
    isChannel,
    ReleaseCatalogUnavailable,
    type CatalogChannel,
    type Channel,
    type ChannelRelease,
    type ReleaseCatalog,
    type ReleaseChannels,
} from './releaseChannels.js';

const LABEL: Record<CatalogChannel, { title: string; blurb: string; install: string }> = {
    stable: {
        title: 'Stable',
        blurb: 'Recommended for everyday use.',
        install: 'Updates the muxr app you already installed directly.',
    },
    nightly: {
        title: 'Nightly',
        blurb: 'The newest build, refreshed as work lands. Expect rough edges.',
        install: 'Installs separately, so it sits alongside stable instead of replacing it.',
    },
    // Retired. Their records are kept so published links keep resolving, and
    // they hand over to nightly as soon as a nightly release exists.
    beta: {
        title: 'Beta',
        blurb: 'Retired. Nightly replaces this channel.',
        install: 'Updates the muxr app you already installed directly.',
    },
    dev: {
        title: 'Dev',
        blurb: 'Retired. Nightly replaces this channel.',
        install: 'Installs separately, so it sits alongside stable instead of replacing it.',
    },
};

function installCommand(release: ChannelRelease): string[] {
    return [`npm install -g --ignore-scripts @trymuxr/cli@${release.npmDistTag}`, 'muxr'];
}

function size(value: number): string {
    return `${Math.round(value / 1_000_000)} MB`;
}

/** A date a person can read, never the raw timestamp. */
function published(value: string): string {
    return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

type Resolution =
    | { kind: 'serve'; channel: CatalogChannel; release: ChannelRelease }
    | { kind: 'redirect'; channel: Channel }
    | { kind: 'unavailable' };

/**
 * A retired channel hands over to nightly the moment a nightly release exists,
 * and until then keeps serving its own historical record. Nothing is ever
 * relabelled: a beta artifact is never presented as nightly, and a missing
 * nightly is unavailable rather than quietly answered by stable.
 */
function resolve(catalog: ReleaseCatalog, requested: CatalogChannel): Resolution {
    const direct = catalog[requested];
    if (requested === 'stable' || requested === 'nightly') {
        return direct === undefined ? { kind: 'unavailable' } : { kind: 'serve', channel: requested, release: direct };
    }
    if (catalog.nightly !== undefined) return { kind: 'redirect', channel: 'nightly' };
    return direct === undefined ? { kind: 'unavailable' } : { kind: 'serve', channel: requested, release: direct };
}

/** One card per channel: what it is, what installing it does, one action. */
function card(channel: Channel, release: ChannelRelease): string {
    const label = LABEL[channel];
    return `<div class="dl-card"><h3>${label.title}</h3><p class="dl-version">${escapeHtml(release.version)}</p>
<p>${escapeHtml(label.blurb)}</p><p>${escapeHtml(label.install)}</p>
<a class="button secondary" href="/downloads/${channel}">Get ${escapeHtml(label.title.toLowerCase())}</a></div>`;
}

/** An honest placeholder: the channel is named, nothing else is substituted. */
function missingCard(channel: Channel): string {
    const label = LABEL[channel];
    return `<div class="dl-card"><h3>${label.title}</h3><p class="dl-version">Unavailable right now</p>
<p>This channel has no published release yet, or its record did not validate.</p></div>`;
}

function writeIndex(res: ServerResponse, catalog: ReleaseCatalog): void {
    writeHtml(res, 200, 'Downloads', `<section class="docs">
${drawing('delivery', 'The ram from the films trotting along with a crate marked muxr on its back', 360, 260, 'drawing spot')}
<p class="eyebrow">Downloads</p><h1>Pick a channel.</h1>
<p class="lede">A browser needs no download: <code>muxr</code> pairs one during setup. These channels are for the CLI and the Android app. Stable is the right choice for almost everyone. Nightly is the newest build, for following development day to day; its Android app installs alongside stable rather than replacing it, so you can keep both.</p>
<div class="dl-cards">${CHANNELS.map((channel) => {
    const release = catalog[channel];
    return release === undefined ? missingCard(channel) : card(channel, release);
}).join('')}</div>
<h2>Phones and stores</h2>
<p>Google Play testing and iOS TestFlight are separate distribution tracks with their own review and rollout. Their versions are not the channels above and do not move with a nightly APK.</p>
<p><a class="textlink" href="https://play.google.com/apps/testing/com.trymuxr.app">Join Google Play testing &#8594;</a> <a class="textlink" href="https://testflight.apple.com/join/aJSbs8pN">Open iOS TestFlight &#8594;</a></p>
</section>`);
}

function writeChannel(res: ServerResponse, channel: CatalogChannel, release: ChannelRelease): void {
    const label = LABEL[channel];
    const retired = channel !== 'stable' && channel !== 'nightly';
    writeHtml(res, 200, `${label.title} downloads`, `<section class="docs">
<p class="eyebrow">${escapeHtml(label.title)} channel</p><h1>muxr ${escapeHtml(release.version)}</h1>
<p class="lede">${escapeHtml(label.blurb)} ${escapeHtml(label.install)}</p>
${retired ? '<p>Nightly has replaced this channel. Once its first release is published, this page moves there; until then the build below is the last one this channel published. Switching over is a one-time <code>npm install -g --ignore-scripts @trymuxr/cli@nightly</code> — an older CLI will not upgrade itself across the change.</p>' : ''}
${term('Install on your computer', installCommand(release))}
<h2>Android</h2>
<p>${escapeHtml(size(release.android.bytes))}, released ${escapeHtml(published(release.publishedAt))}.</p>
<p><a class="button primary" href="/downloads/${channel}/android">Download APK</a> <a class="button secondary" href="/downloads/${channel}/release">Release notes</a></p>
<details><summary>Verify the download</summary><p>Run <code>sha256sum ${escapeHtml(apkFilename(release))}</code> and compare it with the <a class="textlink" href="/downloads/${channel}/checksums">published checksum</a>.</p><p><code>${escapeHtml(release.android.sha256)}</code></p></details>
<p><a class="textlink" href="/downloads">All channels &#8594;</a></p>
</section>`);
}

/**
 * Where the phone's Add your computer link lands. It offers the Linux desktop
 * app only when stable publishes a validated one, and otherwise says so and
 * keeps today's terminal install, so the link never dead-ends.
 */
function writeDesktop(res: ServerResponse, stable: ChannelRelease | undefined, catalogRead: boolean): void {
    const linux = stable?.linux;
    const name = linux?.url.split('/').pop() ?? '';
    const pairNote = '<p>The computer then shows a one-use QR. On your phone, tap <strong>Scan the computer’s QR</strong>, check that the same two words show on both, and approve on the computer.</p>';
    let offer: string;
    if (linux !== undefined && stable !== undefined) {
        offer = `<p class="lede">Get the muxr app for this computer, open it, and pair your phone. No terminal needed unless the computer is missing FUSE 2.</p>
<p><a class="button primary" href="/downloads/stable/linux">Download for Linux</a></p>
<p>muxr ${escapeHtml(stable.version)} for Linux, ${escapeHtml(size(linux.bytes))}. In the downloaded file’s Properties, allow it to run as a program, then open it.</p>
<p>If it will not open, the computer needs FUSE 2. On Ubuntu 24.04 install it with <code>sudo apt install libfuse2t64</code>; older Ubuntu and Debian releases name the package <code>libfuse2</code>. Then open the file again. Without FUSE 2 the file opens only when started with <code>--appimage-extract-and-run</code>, and that flag has to be passed on every launch, so start at login needs FUSE 2 installed.</p>
${pairNote}
<details><summary>Verify the download</summary><p>Run <code>sha256sum ${escapeHtml(name)}</code> and compare it with:</p><p><code>${escapeHtml(linux.sha256)}</code></p></details>
<h2>On a Mac, or prefer a terminal?</h2>
<p>The Mac desktop app comes later. The terminal install works on Linux, macOS and WSL.</p>`;
    } else {
        offer = `<p class="lede">${catalogRead
            ? 'The desktop app download is not published yet.'
            : 'We could not check for the desktop app just now. Try again shortly.'} Until then, install muxr from a terminal on this computer. It pairs with your phone the same way.</p>`;
    }
    writeHtml(res, 200, 'Add your computer', `<section class="docs">
${drawing('pair', 'The developer from the films holds his phone up to the pairing code on his laptop', 480, 300, 'drawing spot')}
<p class="eyebrow">Add your computer</p><h1>Pair this computer with your phone.</h1>
${offer}
${term('Install on your computer', INSTALL)}
<p>Needs Node.js 22 or newer on Linux, macOS or WSL.</p>
${linux === undefined ? pairNote : ''}
<p><a class="textlink" href="/docs/quickstart">Quickstart &#8594;</a></p>
</section>`);
}

function redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, {
        'cache-control': 'no-store',
        location,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
    });
    res.end();
}

function plain(res: ServerResponse, body: string): void {
    res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
    });
    res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
}

/**
 * Permanent download surfaces. A channel that cannot be resolved reports
 * unavailable; it never falls back to another channel or to a built-in version.
 */
export function createDownloadRoutes(channels: ReleaseChannels) {
    const unavailable = (res: ServerResponse, api: boolean): void => {
        if (api) json(res, 503, { error: 'release_catalog_unavailable' });
        else writeMessage(res, 503, 'Downloads unavailable', 'The release catalog could not be read just now, so we will not guess a version. Try again shortly, or browse the releases on GitHub.', '/downloads');
    };

    return async function handleDownloads(path: string, res: ServerResponse): Promise<boolean> {
        const api = path.startsWith('/api/releases/');
        const segments = path.split('/').filter(Boolean);
        const wanted = api ? segments[2] : segments[1];

        if (path === '/desktop') {
            let stable: ChannelRelease | undefined;
            let catalogRead = true;
            try { stable = (await channels.catalog()).stable; }
            catch (error) {
                if (!(error instanceof ReleaseCatalogUnavailable)) throw error;
                catalogRead = false;
            }
            writeDesktop(res, stable, catalogRead);
            return true;
        }

        let channel: CatalogChannel | undefined;
        let action: string | undefined;
        if (path === '/downloads') channel = undefined;
        else if (api && segments.length === 3 && wanted !== undefined && isChannel(wanted)) channel = wanted;
        else if (segments[0] === 'downloads' && wanted !== undefined && isChannel(wanted) && segments.length <= 3) {
            channel = wanted;
            action = segments[2];
        } else return false;

        if (action !== undefined && !['android', 'linux', 'release', 'checksums'].includes(action)) return false;

        try {
            const catalog = await channels.catalog();
            if (channel === undefined) { writeIndex(res, catalog); return true; }
            const resolution = resolve(catalog, channel);
            // A channel with no release of its own never borrows another's.
            if (resolution.kind === 'unavailable') { unavailable(res, api); return true; }
            // A retired channel sends the visitor to the one that replaced it,
            // so the address bar and any bookmark converge on nightly.
            if (resolution.kind === 'redirect') {
                const target = api
                    ? `/api/releases/${resolution.channel}`
                    : `/downloads/${resolution.channel}${action === undefined ? '' : `/${action}`}`;
                redirect(res, target);
                return true;
            }
            const release = resolution.release;
            if (api) { json(res, 200, { channel: resolution.channel, ...release }); return true; }
            if (action === 'android') redirect(res, release.android.url);
            else if (action === 'linux') {
                if (release.linux === undefined) {
                    writeMessage(res, 404, 'No Linux download yet', 'This channel has no published Linux desktop app yet. The desktop page shows the terminal install that pairs the same way.', '/desktop');
                } else redirect(res, release.linux.url);
            }
            else if (action === 'release') redirect(res, release.releaseUrl);
            else if (action === 'checksums') {
                const lines = [`${release.android.sha256}  ${apkFilename(release)}`];
                if (release.linux !== undefined) lines.push(`${release.linux.sha256}  ${linuxFilename(release)}`);
                plain(res, `${lines.join('\n')}\n`);
            }
            else writeChannel(res, resolution.channel, release);
            return true;
        } catch (error) {
            if (!(error instanceof ReleaseCatalogUnavailable)) throw error;
            unavailable(res, api);
            return true;
        }
    };
}
