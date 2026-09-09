/**
 * BYO transactional email for self-host relays. Configure with env:
 * MUXR_EMAIL_PROVIDER=resend, MUXR_RESEND_API_KEY, MUXR_EMAIL_FROM.
 * The interface is the seam — an SMTP provider implements the same two methods.
 */
export interface NotificationEmail {
    send(input: { to: string; subject: string; text: string }): Promise<void>;
}

export class ResendNotificationEmail implements NotificationEmail {
    constructor(
        private readonly apiKey: string,
        private readonly from: string,
    ) {}

    async send(input: { to: string; subject: string; text: string }): Promise<void> {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ from: this.from, to: [input.to], subject: input.subject, text: input.text }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`email provider returned ${response.status}`);
    }
}

/** Wire from env; undefined when unconfigured (notifications disabled). */
export function notificationEmailFromEnv(): { mailer: NotificationEmail; to: string } | undefined {
    const to = process.env.MUXR_NOTIFY_EMAIL?.trim();
    const provider = process.env.MUXR_EMAIL_PROVIDER?.trim().toLowerCase();
    const key = process.env.MUXR_RESEND_API_KEY?.trim();
    const from = process.env.MUXR_EMAIL_FROM?.trim();
    if (to === undefined || to === '') return undefined;
    if (provider !== 'resend' || key === undefined || key === '' || from === undefined || from === '') {
        throw new Error('MUXR_NOTIFY_EMAIL requires MUXR_EMAIL_PROVIDER=resend, MUXR_RESEND_API_KEY and MUXR_EMAIL_FROM');
    }
    return { mailer: new ResendNotificationEmail(key, from), to };
}
