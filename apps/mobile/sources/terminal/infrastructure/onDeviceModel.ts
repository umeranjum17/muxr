import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { initLlama } from 'llama.rn';
import { LocalModel, model, type InferModelStore, type InferState } from '@byokit/infer';

const DIR = `${RNFS.DocumentDirectoryPath}/models`;

// The kit's model store over the app's files: it downloads only the kit's pinned URL and hashes natively.
const store: InferModelStore = {
    path: (m) => `${DIR}/${m.id}.gguf`,
    size: async (m) => (await RNFS.exists(store.path(m))) ? Number((await RNFS.stat(store.path(m))).size) : undefined,
    download: async (m, o) => {
        await RNFS.mkdir(DIR);
        if (o.signal?.aborted) throw new Error('Download cancelled before the request.');
        const job = RNFS.downloadFile({ fromUrl: m.url, toFile: store.path(m), progressInterval: 500, progressDivider: 1,
            progress: (p) => o.onProgress?.(p.bytesWritten, p.contentLength) });
        const stop = () => RNFS.stopDownload(job.jobId);
        o.signal?.addEventListener('abort', stop, { once: true });
        try {
            const result = await job.promise;
            if (result.statusCode !== 200) throw new Error(`download ${result.statusCode}`);
        } finally {
            o.signal?.removeEventListener('abort', stop);
        }
    },
    sha256: (m) => RNFS.hash(store.path(m), 'sha256'),
    remove: async (m) => { if (await RNFS.exists(store.path(m))) await RNFS.unlink(store.path(m)); },
    freeBytes: async () => (await RNFS.getFSInfo()).freeSpace,
};

/** BYOKit's on-device model for this phone: the kit's pinned model, llama.rn as its binding. */
export function openOnDeviceModel(onState: (state: InferState) => void): LocalModel | null {
    return new LocalModel({
        model: model(),
        store,
        initLlama,
        onState,
        device: {
            platform: Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'other',
            abi: Platform.OS === 'android' ? Device.supportedCpuArchitectures?.[0] : undefined,
            totalMemoryBytes: Device.totalMemory ?? undefined,
        },
    });
}
