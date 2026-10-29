/** The one sign-in this phone keeps for the chat: the store is named by it. */
export const PHONE_MEMBER = 'this-phone';

/** The account a "Just this phone" chat answers from. It never changes. */
export const PHONE_ACCOUNT = 'chatgpt';

export const PHONE_INSTRUCTIONS = [
    'You are muxr, running on this phone only. No computer is connected.',
    'Answer in plain, short sentences without jargon.',
    'You can change the look of the app with set_theme. Use it when the person asks for a darker, lighter or automatic look.',
    'Anything that needs a computer, say so in one line.',
].join(' ');

export const PHONE_SUGGESTION = 'Make the app dark';
