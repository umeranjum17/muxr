import { CANONICAL_REPOSITORY } from '../domain/channelCatalog.mjs';
import { readReleaseMetadata, setReleaseNotes } from '../infrastructure/catalogBranch.mjs';

const START = '<!-- owner-authorization -->';
const END = '<!-- /owner-authorization -->';

/** The release notes with the owner-authorization section set to `notice`, replacing an earlier one. */
export function withOwnerAuthorization(body, notice) {
    const start = body.indexOf(START);
    const end = body.indexOf(END);
    const kept = start >= 0 && end > start ? `${body.slice(0, start)}${body.slice(end + END.length)}`.trim() : body.trim();
    return `${kept}\n\n${START}\n## Owner-authorized, not owner-tested\n\n${notice}\n${END}\n`;
}

/** Puts the notice at the end of the tag's GitHub release notes; a rerun replaces it instead of repeating it. */
export function noteOwnerAuthorization({ repository = CANONICAL_REPOSITORY, tag, notice }) {
    const release = readReleaseMetadata({ repository, tag });
    const body = withOwnerAuthorization(release.body, notice);
    if (body !== release.body) setReleaseNotes({ repository, id: release.id, body });
}
