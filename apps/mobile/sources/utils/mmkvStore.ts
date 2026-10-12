import { createMMKV, type MMKV } from 'react-native-mmkv';

export function createStore(): MMKV {
    const store = createMMKV();
    const set = store.set.bind(store);
    store.set = (...args: Parameters<MMKV['set']>) => {
        try {
            set(...args);
        } catch (e) {
            console.error(`Failed to save ${args[0]}`, e);
        }
    };
    return store;
}
