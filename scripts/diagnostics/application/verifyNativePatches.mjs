import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const ghosttyPatch = read('patches/expo-libghostty+0.8.1.patch');
const ghosttyView = read('node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/ExpoLibghosttyView.kt');
const ghosttyTerminal = read('node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/GhosttyTerminalView.kt');
const ghosttyNative = read('node_modules/expo-libghostty/android/src/main/cpp/ghostty_jni.cpp');
const liveAudioPatch = read('patches/react-native-live-audio-stream+1.1.1.patch');
const liveAudioModule = read(
    'node_modules/react-native-live-audio-stream/android/src/main/java/com/imxiqi/rnliveaudiostream/RNLiveAudioStreamModule.java',
);
const imageSizePatch = read('patches/image-size+1.2.1.patch');
const imageSizeIcns = read('node_modules/image-size/dist/types/icns.js');
const imageSizeProbe = spawnSync(
    process.execPath,
    [
        '-e',
        `const { imageSize } = require(process.argv[1]);
const input = Buffer.alloc(16);
input.write('icns');
input.writeUInt32BE(16, 4);
input.write('ic07', 8);
try {
    imageSize(input);
    process.exit(2);
} catch (error) {
    process.exit(String(error).includes('Invalid ICNS image entry length') ? 0 : 3);
}`,
        fileURLToPath(new URL('node_modules/image-size', root)),
    ],
    { timeout: 1_000 },
);
const androidBuild = read('scripts/buildAndroidLocal.sh');
const voiceOverlayService = read('apps/mobile/modules/voice-overlay/android/src/main/java/expo/modules/voiceoverlay/VoiceOverlayService.kt');
const voiceOverlayModule = read('apps/mobile/modules/voice-overlay/android/src/main/java/expo/modules/voiceoverlay/VoiceOverlayModule.kt');
const whisperModel = readFileSync(new URL('apps/mobile/sources/assets/models/ggml-base.en-q5_1.bin', root));
const nativeGuard = androidBuild.indexOf('node "$ROOT/scripts/diagnostics/application/verifyNativePatches.mjs"');
const workspaceBuild = androidBuild.indexOf('(cd "$ROOT" && yarn build)');
const vitestGate = androidBuild.indexOf('npx vitest run');
const gradleBuild = androidBuild.indexOf(':app:assembleRelease');
const checks = [
    ['Ghostty patch hides its accessory bar', ghosttyPatch.includes('accessoryBar.visibility = GONE') && ghosttyView.includes('accessoryBar.visibility = GONE')],
    ['Ghostty patch forwards scroll rows', ghosttyPatch.includes('onScrollRows') && ghosttyTerminal.includes('onScrollRows') && ghosttyView.includes('onScroll')],
    ['Ghostty patch renders Kitty graphics and forwards pointer geometry',
        ghosttyPatch.includes('nativeKittySnapshot') && ghosttyNative.includes('nativeKittySnapshot') &&
        ghosttyTerminal.includes('drawKitty') && ghosttyTerminal.includes('pointerMode') && ghosttyView.includes('cellWidthPx')],
    [
        'dictation recorder releases AudioRecord only after the read loop exits',
        liveAudioPatch.includes('stopAndReleaseRecorder') &&
            liveAudioPatch.includes('thread.join()') &&
            !liveAudioPatch.includes('thread.join(250)') &&
            liveAudioPatch.includes('while (thread.isAlive())') &&
            liveAudioModule.includes('stopAndReleaseRecorder()') &&
            liveAudioModule.includes('thread.join()') &&
            !liveAudioModule.includes('thread.join(250)') &&
            liveAudioModule.includes('while (thread.isAlive())') &&
            liveAudioModule.indexOf('while (thread.isAlive())') < liveAudioModule.indexOf('current.release()') &&
            liveAudioPatch.includes('Base64.encodeToString(buffer, 0, bytesRead, Base64.NO_WRAP)') &&
            liveAudioModule.includes('Base64.encodeToString(buffer, 0, bytesRead, Base64.NO_WRAP)'),
    ],
    [
        'dictation recorder init/start reject instead of silently failing',
        liveAudioPatch.includes('init(ReadableMap options, Promise promise)') &&
            liveAudioPatch.includes('public void start(Promise promise)') &&
            liveAudioModule.includes('promise.reject("E_INIT"') &&
            liveAudioModule.includes('promise.reject("E_START"') &&
            liveAudioModule.includes('promise.resolve(true)'),
    ],
    [
        'image-size patch rejects zero-length ICNS entries without hanging',
        (imageSizePatch.match(/Invalid ICNS image entry length/g) ?? []).length === 2 &&
            (imageSizeIcns.match(/Invalid ICNS image entry length/g) ?? []).length === 2 &&
            imageSizeProbe.status === 0 &&
            !imageSizeProbe.error,
    ],
    [
        'on-device dictation bundles the verified quantized Whisper Base English model',
        whisperModel.length === 59_721_011 &&
            createHash('sha256').update(whisperModel).digest('hex') === '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f',
    ],
    [
        'notification Talk foregrounds the Activity before microphone capture',
        voiceOverlayService.includes('private fun startVoice(context: Context)') &&
            voiceOverlayService.includes('PendingIntent.getActivity(') &&
            voiceOverlayService.includes('.putExtra(EXTRA_ACTIVITY_ACTION, "start")') &&
            voiceOverlayService.includes('builder.addAction(0, "Talk", startVoice(context))') &&
            voiceOverlayService.includes('.addAction(0, "Hang Up", stopVoice(context))') &&
            voiceOverlayService.includes('if (voiceMuted) "Unmute" else "Mute"') &&
            voiceOverlayModule.includes('OnNewIntent(::consumeActivityAction)') &&
            voiceOverlayModule.includes('OnActivityEntersForeground'),
    ],
    [
        'Android build prepares workspace outputs after native guards and before Vitest/Gradle',
        nativeGuard >= 0 &&
            nativeGuard < workspaceBuild &&
            workspaceBuild < vitestGate &&
            vitestGate < gradleBuild,
    ],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
    for (const [name] of failed) console.error(`✗ ${name}`);
    console.error('Required patches or Android build prerequisites are missing/stale; refusing to continue.');
    process.exit(1);
}
for (const [name] of checks) console.log(`✓ ${name}`);
