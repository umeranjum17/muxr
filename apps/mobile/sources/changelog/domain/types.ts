export type VerificationStatus = 'passed' | 'partial' | 'failed' | 'not-run';

export interface ChangelogChange {
    title: string;
    detail: string;
}

export interface ChangelogEvidence {
    path?: string;
    sha256?: string;
    testedCommit: string;
    artifactSha256?: string;
    environment: string;
    checkedBy: string;
    checkedAt: string;
}

export interface ChangelogVerification extends ChangelogChange {
    status: VerificationStatus;
    evidence?: ChangelogEvidence;
}

export interface ChangelogRelease {
    appVersion: string;
    title: string;
    summary: string;
    features: ChangelogChange[];
    fixes: ChangelogChange[];
    verification: ChangelogVerification[];
    knownLimits: string[];
}

/** Historical entries written before releases were keyed by app version. */
export interface LegacyChangelogEntry {
    title: string;
    summary: string;
    markdown: string;
}

export interface ChangelogData {
    releases: ChangelogRelease[];
    legacyEntries: LegacyChangelogEntry[];
}
