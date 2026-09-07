import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IOS_FRAMEWORK, verifyIosLibraries, verifyIosPin } from './syncIosFramework.mjs';

const root = new URL('../../..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const ghosttyPatch = read('patches/expo-libghostty+0.8.1.patch');
const ghosttyView = read('node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/ExpoLibghosttyView.kt');
const ghosttyTerminal = read('node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/GhosttyTerminalView.kt');
const ghosttyIosModule = read('node_modules/expo-libghostty/ios/ExpoLibghosttyModule.swift');
const ghosttyIosView = read('node_modules/expo-libghostty/ios/ExpoLibghosttyView.swift');
const ghosttyIosTerminal = read('node_modules/expo-libghostty/ios/vendor/GhosttyTerminal/Platform/UIKit/UITerminalView.swift');
const ghosttyIosInteraction = read('node_modules/expo-libghostty/ios/vendor/GhosttyTerminal/Platform/UIKit/UITerminalView+Interaction.swift');
const liveAudioPatch = read('patches/react-native-live-audio-stream+1.1.1.patch');
const liveAudioModule = read(
    'node_modules/react-native-live-audio-stream/android/src/main/java/com/imxiqi/rnliveaudiostream/RNLiveAudioStreamModule.java',
);
const imageSizePatch = read('patches/image-size+1.2.1.patch');
const imageSizeIcns = read('node_modules/image-size/dist/types/icns.js');
const screensPatch = read('patches/react-native-screens+4.22.0.patch');
const workletsPatch = read('patches/react-native-worklets+0.7.2.patch');
const frameQueue = read('node_modules/react-native-worklets/android/src/main/java/com/swmansion/worklets/runloop/AnimationFrameQueue.java');
const workletsLegacyModule = read('node_modules/react-native-worklets/android/src/legacyBundling/com/swmansion/worklets/WorkletsModule.java');
const workletsExperimentalModule = read('node_modules/react-native-worklets/android/src/experimentalBundling/com/swmansion/worklets/WorkletsModule.java');
const reanimatedPatch = read('patches/react-native-reanimated+4.2.3.patch');
const reanimatedNativeProxy = read('node_modules/react-native-reanimated/android/src/main/java/com/swmansion/reanimated/NativeProxy.java');
const screensProxy = read('node_modules/react-native-screens/android/src/main/cpp/NativeProxy.cpp');
const screensListener = read('node_modules/react-native-screens/cpp/RNSScreenRemovalListener.h');
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
    ['Terminal supports an explicit keyboard without raising one on every tap',
        ghosttyPatch.includes('autoShowKeyboard') &&
        ghosttyTerminal.includes('if (autoShowKeyboard) showKeyboard()') &&
        ghosttyView.includes('fun showKeyboard() = terminal.showKeyboard()') &&
        read('node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/ExpoLibghosttyModule.kt').includes('AsyncFunction("showKeyboard")') &&
        read('node_modules/expo-libghostty/build/ExpoLibghosttyView.js').includes('native.current.showKeyboard()') &&
        ghosttyIosTerminal.includes('open var autoShowKeyboard = true') &&
        ghosttyIosModule.includes('AsyncFunction("showKeyboard")') &&
        ghosttyIosView.includes('terminalView.showKeyboard()')],
    // Android takes focus on every tap and only gates the IME, so hardware and
    // accessory keys keep working with the keyboard down. iOS cannot resign to
    // hide one without losing key input, so an empty input view stands in.
    ['A suppressed iOS keyboard still leaves the terminal holding key input',
        ghosttyIosTerminal.includes('softwareKeyboardSuppressed ? suppressedInputView : nil') &&
        // Bounded to the branch body: [^}] cannot cross the closing brace, so
        // this fails if the call is removed, comment or no comment.
        /\} else if autoShowKeyboard \{[^}]*showKeyboard\(\)/.test(ghosttyIosInteraction) &&
        ghosttyIosInteraction.includes('softwareKeyboardSuppressed = true\n                    becomeFirstResponder()') &&
        ghosttyIosTerminal.includes('guard softwareKeyboardSuppressed != oldValue, isFirstResponder else { return }')],
    ['Ghostty patch hides its accessory bar on Android and iOS',
        ghosttyPatch.includes('accessoryBar.visibility = GONE') &&
        ghosttyView.includes('accessoryBar.visibility = GONE') &&
        ghosttyPatch.includes('terminalView.inputAccessoryItems = []') &&
        ghosttyIosView.includes('terminalView.inputAccessoryItems = []')],
    [
        'Ghostty patch supports symmetric hideKeyboard alongside showKeyboard',
        ghosttyPatch.includes('AsyncFunction("hideKeyboard")') &&
            ghosttyPatch.includes('fun hideKeyboard() = terminal.hideKeyboard()') &&
            ghosttyPatch.includes('hideSoftInputFromWindow') &&
            ghosttyPatch.includes('clearFocus()') &&
            ghosttyTerminal.includes('if (!isAttachedToWindow || windowToken == null) return') &&
            !ghosttyTerminal.includes('fun hideKeyboard() {\n    if (handle == 0L || finished') &&
            ghosttyView.includes('fun hideKeyboard() = terminal.hideKeyboard()') &&
            read('node_modules/expo-libghostty/android/src/main/java/expo/modules/libghostty/ExpoLibghosttyModule.kt').includes('AsyncFunction("hideKeyboard")') &&
            read('node_modules/expo-libghostty/build/ExpoLibghosttyView.js').includes('native.current.hideKeyboard()') &&
            read('node_modules/expo-libghostty/build/ExpoLibghostty.types.d.ts').includes('hideKeyboard(): Promise<void>') &&
            ghosttyIosModule.includes('AsyncFunction("hideKeyboard")') &&
            ghosttyIosView.includes('terminalView.hideKeyboard()'),
    ],
    ['Ghostty patch forwards scroll rows', ghosttyPatch.includes('onScrollRows') && ghosttyTerminal.includes('onScrollRows') && ghosttyView.includes('onScroll')],
    [
        'Ghostty patch keeps Android Kitty snapshot plus metrics and pointer on both platforms',
        ghosttyPatch.includes('nativeKittyGeneration') &&
            ghosttyPatch.includes('nativeKittySnapshot') &&
            ghosttyPatch.includes('drawKitty') &&
            ghosttyPatch.includes('imageWidth.toLong() * imageHeight.toLong()') &&
            ghosttyPatch.includes('pointerMode') &&
            ghosttyPatch.includes('cellWidthPx') &&
            ghosttyPatch.includes('onTerminalPointer') &&
            ghosttyTerminal.includes('drawKitty') &&
            ghosttyTerminal.includes('nativeKittySnapshot') &&
            ghosttyView.includes('pointerMode') &&
            ghosttyView.includes('cellWidthPx') &&
            ghosttyIosModule.includes('onTerminalPointer') &&
            ghosttyIosView.includes('pointerMode') &&
            ghosttyIosView.includes('cellWidthPx') &&
            !ghosttyIosView.includes('nativeKittySnapshot') &&
            !ghosttyIosView.includes('drawKitty'),
    ],
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
    [
        // Source-level identity, checkable anywhere: a Linux checkout holds
        // whatever binary the dependency fetched before the patch applied.
        'iOS libghostty pin names the artifact the patched manifest fetches',
        verifyIosPin().length === 0,
    ],
    [
        'iOS framework pin travels in the dependency patch, so it survives a fresh install',
        ghosttyPatch.includes('vendor-manifest.json') && ghosttyPatch.includes(IOS_FRAMEWORK.zipSha256),
    ],
    [
        // The stamp beside the framework is a skip-the-download hint, never
        // evidence: this recomputes the library bytes a build actually links,
        // on the only platform that installs them.
        'iOS libghostty libraries match their pinned digests (Darwin)',
        process.platform !== 'darwin' || verifyIosLibraries().length === 0,
    ],
    [
        'screens mounting-override listener is process-lifetime and cannot dangle (upstream PR 4413)',
        screensPatch.includes('removalListener()') &&
            screensProxy.includes('static const std::shared_ptr<RNSScreenRemovalListener> instance') &&
            screensProxy.includes('removalListener()->setListener([javaPart = javaPart_]') &&
            screensProxy.includes('if (!javaPart_)') &&
            screensProxy.includes('removalListener()->clearListener(removalListenerToken_)') &&
            !screensProxy.includes('screenRemovalListener_') &&
            screensListener.includes('uint64_t setListener(') &&
            screensListener.includes('mutable std::mutex listenerMutex_'),
    ],
    [
        'worklets animation frame queue stops on invalidate (upstream PR 10278 backport)',
        workletsPatch.includes('mDispatchLock') &&
            frameQueue.includes('private final AtomicBoolean mInvalidated = new AtomicBoolean();') &&
            frameQueue.includes('private final Object mDispatchLock = new Object();') &&
            frameQueue.includes('public void invalidate() {') &&
            frameQueue.includes('private void removePostedFrameCallback() {') &&
            // The dispatch lock has to wrap the callback loop, and the queue must
            // refuse new work and new choreographer posts once invalidated.
            frameQueue.indexOf('synchronized (mDispatchLock) {\n      var frameCallbacks = pullCallbacks();') > 0 &&
            frameQueue.indexOf('if (mInvalidated.get()) {\n        return;\n      }\n\n      lastFrameTimeMs') > 0 &&
            frameQueue.indexOf('if (mInvalidated.get()) {\n        return;\n      }\n      mFrameCallbacks.add(') > 0 &&
            frameQueue.indexOf('if (mInvalidated.get()) {\n        return;\n      }\n      if (!mPaused.get()') > 0,
    ],
    [
        'both worklets module variants stop the frame queue before invalidateCpp',
        [workletsLegacyModule, workletsExperimentalModule].every((module) =>
            module.includes('public void invalidateAnimationFrameQueue() {') &&
            module.includes('mAnimationFrameQueue.invalidate();') &&
            module.indexOf('invalidateAnimationFrameQueue();\n    if (mHybridData') > 0 &&
            module.indexOf('invalidateAnimationFrameQueue();') < module.indexOf('invalidateCpp();')),
    ],
    [
        'reanimated stops the shared frame queue before releasing its Java part',
        reanimatedPatch.includes('mWorkletsModule.invalidateAnimationFrameQueue();') &&
            reanimatedNativeProxy.includes('mWorkletsModule.invalidateAnimationFrameQueue();') &&
            reanimatedNativeProxy.indexOf('mWorkletsModule.invalidateAnimationFrameQueue();') < reanimatedNativeProxy.indexOf('invalidateCpp();\n    }') &&
            // The fix is the queue barrier, so this patch stays scoped to the one
            // Java file: no C++ null guard or fabricated timestamp rides along.
            (reanimatedPatch.match(/^diff --git/gm) ?? []).length === 1 &&
            !reanimatedPatch.includes('.cpp'),
    ],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
    for (const [name] of failed) console.error(`✗ ${name}`);
    console.error('Required patches or Android build prerequisites are missing/stale; refusing to continue.');
    process.exit(1);
}
for (const [name] of checks) console.log(`✓ ${name}`);
