import { File, Paths } from 'expo-file-system';
import type { PhoneLog } from '@byokit/phone';

/** The chat on this phone: one file in the app's documents directory, read, append and clear only. */
export function phoneLog(): PhoneLog {
    const file = new File(Paths.document, 'phone-chat.jsonl');
    return {
        read: async () => file.exists ? file.textSync().split('\n').filter(Boolean) : [],
        append: async (line) => {
            if (!file.exists) file.create({ intermediates: true });
            file.write(`${line}\n`, { append: true });
        },
        clear: async () => { if (file.exists) file.delete(); },
    };
}
