import { Platform } from 'react-native';
import { deleteNativeSecret, getNativeSecret, setNativeSecret } from './nativeSecretStore';
import { deleteWebSecret, getWebSecret, listWebSecretNames, setWebSecret } from './webSecureStore';

export const secretGet = (key: string): Promise<string | null> => Platform.OS === 'web' ? getWebSecret(key) : getNativeSecret(key);
export const secretSet = (key: string, value: string): Promise<void> => Platform.OS === 'web' ? setWebSecret(key, value) : setNativeSecret(key, value);
export const secretDelete = (key: string): Promise<void> => Platform.OS === 'web' ? deleteWebSecret(key) : deleteNativeSecret(key);

/** Browser commits can outlive an interrupted index write. */
export async function grantSecretNames(): Promise<string[]> {
    if (Platform.OS !== 'web') return [];
    return (await listWebSecretNames()).filter((key) => key.startsWith('muxr.grant.'))
        .map((key) => key.slice('muxr.grant.'.length));
}
