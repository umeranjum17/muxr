export const MOBILE_ONBOARDING_CHOICES = ['Scan to connect'] as const;
export const SETUP_COMMAND = 'node scripts/cli.mjs setup';

export function setupEmptyState(publicBaseUrl?: string): {
    title: string;
    command: string;
    setupUrl?: string;
} {
    const base = publicBaseUrl?.trim().replace(/\/$/, '');
    return {
        title: 'Connect your computer',
        command: SETUP_COMMAND,
        ...(base ? { setupUrl: `${base}/setup` } : {}),
    };
}

export function firstRestorableMachine(machines: Array<{ id?: unknown; paired?: unknown }>): string | undefined {
    const id = machines.find((machine) => machine.paired === true && typeof machine.id === 'string')?.id;
    return typeof id === 'string' ? id : undefined;
}

/** The fully open-source launch has no price, checkout, upgrade, or purchase surface. */
export function directBillingUrl(_config: { directDistribution?: boolean; publicBaseUrl?: string }): null {
    return null;
}
