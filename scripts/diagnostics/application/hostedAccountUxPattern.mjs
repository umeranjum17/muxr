// Bans the removed singular hosted-account screen (settings/account) without
// catching the legitimate plural plans route (settings/accounts).
export const hostedAccountUxPattern =
    /settings\/account(?![A-Za-z])|Account and preferences|Email, hosted status|Manage your account/;
