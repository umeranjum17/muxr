import { releaseBuild } from '../domain/releaseJourney.mjs';
import { checkJourneyReceipt } from './checkJourneyReceipt.mjs';

/**
 * Whether a stable version may be published to npm. Trusted publishing (OIDC)
 * can publish a version but cannot move a dist-tag, so a stable version is
 * published straight under `latest`, and only once this accepts it: the
 * release tag points at the commit its sealed manifest names, the tarball
 * about to be published is byte for byte the one that manifest sealed, and a
 * committed receipt proves the release journey passed on that exact build,
 * and the captain started the run by hand naming this version as one he
 * tested on his own phone (`captainTested`; a push names none). It never
 * publishes. Returns `{ ok: true, proof }` or `{ ok: false, reason }`.
 */
export function acceptStable({ version, manifest, taggedCommit, tarballSha256, captainTested, repo = process.cwd(), receiptsRef = 'origin/main' }) {
    const tag = `v${version}`;
    if (manifest.release?.channel !== 'stable') return { ok: false, reason: `${tag} is a ${manifest.release?.channel} release; only stable becomes npm latest` };
    if (manifest.source?.commit !== taggedCommit) return { ok: false, reason: `${tag} points at ${taggedCommit}, but its manifest was sealed from ${manifest.source?.commit}` };
    const build = releaseBuild(manifest);
    if (build.version !== version) return { ok: false, reason: `${tag} carries ${build.version}, not ${version}` };
    if (build.package === undefined) return { ok: false, reason: `${tag} has no npm tarball in its manifest` };
    if (tarballSha256 !== build.package) {
        return { ok: false, reason: `the tarball to publish (sha256 ${tarballSha256.slice(0, 12)}) is not the ${tag} tarball the journey tests (${build.package.slice(0, 12)}); run release.yml on the ${tag} tag` };
    }
    const proof = checkJourneyReceipt({ repo, commit: taggedCommit, receiptsRef, build });
    if (!proof.ok) return { ok: false, reason: `${version} has no passing release journey on its exact build:\n${proof.reason}` };
    if (captainTested !== version) {
        return { ok: false, reason: `${version} passed its release journey (${proof.path}), but becomes latest only from a release.yml run started by hand with captain_tested and version ${version}` };
    }
    return { ok: true, proof: proof.path };
}
