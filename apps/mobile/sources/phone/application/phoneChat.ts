import { randomUUID } from 'expo-crypto';
import { PhoneSession, type PhoneTool } from '@byokit/phone';
import { setThemePreference } from '@/settings';
import { PHONE_ACCOUNT, PHONE_INSTRUCTIONS, PHONE_MEMBER } from '../domain/phone';
import { phoneAccounts } from '../infrastructure/phoneAccounts';
import { phoneLog } from '../infrastructure/phoneLog';

export const accounts = phoneAccounts();
const log = phoneLog();

const THEMES = { light: 'light', dark: 'dark', system: 'adaptive' } as const;

// The app's own Appearance > Theme. Setting it twice gives the same result, so a cut-off call may run again.
const setTheme: PhoneTool = {
    name: 'set_theme',
    description: 'Change the look of the muxr app on this phone.',
    parameters: {
        type: 'object',
        properties: { theme: { type: 'string', enum: Object.keys(THEMES), description: 'light, dark, or system to follow the phone' } },
        required: ['theme'],
    },
    replaySafe: true,
    run: async (args) => {
        const theme = String(args.theme);
        if (!(theme in THEMES)) return 'That is not a theme. Use light, dark or system.';
        setThemePreference(THEMES[theme as keyof typeof THEMES]);
        return `The app is now ${theme === 'system' ? 'following the phone' : theme}.`;
    },
};

export const isSignedIn = (): Promise<boolean> => accounts.signedIn(PHONE_MEMBER, PHONE_ACCOUNT);

let opened: Promise<PhoneSession<string>> | undefined;

/** The chat on this phone, read from its file once; leaving the screen and coming back finds the same session. */
export function openPhoneChat(): Promise<PhoneSession<string>> {
    opened ??= (async () => {
        // The kit never guesses a model: the first one this plan lists is the one used.
        const model = (await accounts.models(PHONE_MEMBER, PHONE_ACCOUNT)).find((m) => m.available)?.id;
        if (model === undefined) throw new Error('Your plan lists no model for this phone yet.');
        // Hermes has no globalThis.crypto.randomUUID, the kit's default for a turn's id.
        return PhoneSession.open({ accounts, member: PHONE_MEMBER, account: PHONE_ACCOUNT, model, instructions: PHONE_INSTRUCTIONS, tools: [setTheme], log, newId: randomUUID });
    })();
    opened.catch(() => { opened = undefined; });
    return opened;
}

/** A chat is kept when its file has lines; Home offers to continue it. */
export async function phoneChatExists(): Promise<boolean> {
    return (await log.read()).length > 0;
}

/** Sign out here and forget the chat; the next "Just this phone" starts clean. */
export async function endPhoneChat(): Promise<void> {
    opened = undefined;
    await log.clear();
    await accounts.logout(PHONE_MEMBER, PHONE_ACCOUNT);
}
