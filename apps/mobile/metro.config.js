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
// Also keep the isolated host's changing runtime state outside the watch graph.
config.resolver.blockList = [
  /[/\\]src-tauri[/\\]target[/\\].*/,
  /[/\\](?:\.cxx|\.gradle)[/\\].*/,
  /[/\\](?:android|ReactAndroid)[/\\](?:.*[/\\])?build(?:[/\\].*)?$/,
  /[/\\]\.cache[/\\]muxr-dev[/\\].*/,
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
const contractEntry = path.resolve(workspaceRoot, "packages/contract/dist/index.js");
const cryptoEntry = path.resolve(workspaceRoot, "packages/crypto/dist/index.js");

// The diff viewer's `shiki` is the slim static bundle on every platform:
// the stock entry lazy-imports every grammar and their shared subtrees end
// up in the eager __common chunk (see shikiSlim.ts).
const shikiSlimPath = path.resolve(__dirname, 'sources/components/diff/shikiSlim.ts');

const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'shiki' && !context.originModulePath.includes('shikiSlim')) {
    return { filePath: shikiSlimPath, type: 'sourceFile' };
  }
  if (moduleName === 'preact') {
    return { filePath: preactCjsPath, type: 'sourceFile' };
  }
  if (moduleName === 'preact/hooks') {
    return { filePath: preactHooksCjsPath, type: 'sourceFile' };
  }
  if (moduleName === '@muxr/contract') {
    return { filePath: contractEntry, type: 'sourceFile' };
  }
  if (moduleName === '@muxr/crypto') {
    return { filePath: cryptoEntry, type: 'sourceFile' };
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