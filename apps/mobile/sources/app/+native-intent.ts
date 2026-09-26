import { linkOfferFromUrl } from '../pairing/domain/pairingString';

/** Expo Router handles the path; preserve a link offer in an ordinary Pair route param. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
    const offer = linkOfferFromUrl(path);
    return offer === undefined ? path : `/pair?offer=${encodeURIComponent(offer)}`;
}
