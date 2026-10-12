import { createMMKV, type MMKV } from 'react-native-mmkv';

/** Every app store comes from here: a failed `set` is logged, never thrown into a UI handler. */
export function createStore(): MMKV {
    const store = createMMKV();
    const set = store.set.bind(store);
    // defineProperty, not assignment: debug builds freeze the Nitro prototype, so
    // `store.set = …` throws in a module and the store never loads.
    Object.defineProperty(store, 'set', {
        value: (...args: Parameters<MMKV['set']>) => {
            try {
                set(...args);
            } catch (e) {
                console.error(`Failed to save ${args[0]}`, e);
            }
        },
    });
    return store;
}
