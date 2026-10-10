const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

config.watchFolders = [...(config.watchFolders ?? []), workspaceRoot];

// Add support for .wasm files (required by Skia for all platforms)
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/installation/
config.resolver.assetExts.push('wasm', 'bin');
// Native builds create/delete transient directories while Metro is watching.
// They are not JS inputs; exclude them so Fast Refresh survives a debug rebuild.
// Also exclude caches/temp/native outputs. Keep JS dist/build packages and
// assets: those are real bundle inputs, unlike compiler scratch directories.
config.resolver.blockList = [
  /[/\\]src-tauri[/\\]target[/\\].*/,
  /[/\\](?:\.cache|\.tmp|\.temp|\.cxx|\.gradle|__pycache__|DerivedData)(?:[/\\].*)?$/,
  /[/\\](?:android|ios|ReactAndroid)[/\\](?:.*[/\\])?(?:build|Pods)(?:[/\\].*)?$/,
];

// Force every preact / preact/hooks import (ESM or CJS, from any package) to
// resolve to a SINGLE file. preact's package.json exports field maps "import"
// to preact.mjs and "require" to preact.js, which makes Metro register two
// separate module instances depending on the importer's module type. Two
// instances mean two `options` objects — preact/hooks patches one,
// @pierre/trees renders against the other, currentComponent stays undefined,
// `r.__H` crashes. Pin to the CJS bundles so everyone shares state.
const preactCjsPath = require.resolve('preact');
const preactHooksCjsPath = require.resolve('preact/hooks');

// The diff viewer's `shiki` resolves to shikiSlim.ts on web, which loads a
// fixed slim grammar set with the diff view; other languages render as plain
// text on web. Native never draws the web diff, so the alias stays scoped to
// web and leaves the native bundle untouched.
const shikiSlimPath = path.resolve(__dirname, 'sources/components/diff/shikiSlim.ts');

const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'shiki') {
    return { filePath: shikiSlimPath, type: 'sourceFile' };
  }
  if (moduleName === 'preact') {
    return { filePath: preactCjsPath, type: 'sourceFile' };
  }
  if (moduleName === 'preact/hooks') {
    return { filePath: preactHooksCjsPath, type: 'sourceFile' };
  }
  // The shared packages resolve like any installed dependency, so the app
  // reads the pinned version whether it is the workspace or the registry.
  if (moduleName.startsWith('@trymuxr/contract') || moduleName.startsWith('@trymuxr/crypto')) {
    return { filePath: require.resolve(moduleName), type: 'sourceFile' };
  }
  if (baseResolveRequest) {
    return baseResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Enable inlineRequires for proper Skia and Reanimated loading
// Source: https://shopify.github.io/react-native-skia/docs/getting-started/web/
// Without this, Skia throws "react-native-reanimated is not installed" error
// This is cross-platform compatible (iOS, Android, web)
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true, // Critical for @shopify/react-native-skia
  },
});

module.exports = config;