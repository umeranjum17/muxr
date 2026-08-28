import { resolvePluginText as resolveForLanguage, type PluginText } from '@muxr/contract';
import { getCurrentLanguageTag } from '@/text';

/** Resolve manifest copy with the phone's current language preference. */
export function resolvePluginText(value: PluginText): string {
    return resolveForLanguage(value, getCurrentLanguageTag());
}
