# iOS

Not implemented. The package's JS surface, protocol types and readiness/gesture
model are platform-neutral, so an iOS backend implements the same native module
name (`Desklink`) with:

- a `RTCMTLVideoView`-backed surface instead of `SurfaceViewRenderer`,
- `RTCDefaultVideoDecoderFactory` (hardware-first, VP9 included) instead of
  `DefaultVideoDecoderFactory`,
- `UITextInput`/`UIKeyInput` for the keyboard bridge instead of
  `InputConnectionWrapper`,
- `UIPasteboard` for the explicit clipboard transfer.

None of that is written or tested, so the package advertises Android only in
`expo-module.config.json` rather than compiling an untested stub.
