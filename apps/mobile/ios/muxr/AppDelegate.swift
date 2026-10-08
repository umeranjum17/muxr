internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    trimKeyboardlessTextViewMenu()

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

// The Select Text viewer is an editable multiline field with no keyboard, so iOS
// keeps Select All in its menu; this drops the edits a viewer never makes (Cut,
// Paste, AutoFill) from any multiline field without a keyboard. Every other field
// keeps the stock menu. RN core ships prebuilt, so this cannot live in a patch.
private func trimKeyboardlessTextViewMenu() {
  // Tied to RN's private RCTUITextView: if a React Native upgrade renames it or
  // its methods, do nothing and leave the stock menu.
  let canSel = #selector(UIResponder.canPerformAction(_:withSender:))
  let buildSel = #selector(UIResponder.buildMenu(with:))
  guard let cls = NSClassFromString("RCTUITextView"),
        let can = class_getInstanceMethod(cls, canSel),
        let build = class_getInstanceMethod(cls, buildSel) else { return }

  typealias CanPerform = @convention(c) (AnyObject, Selector, Selector, Any?) -> Bool
  let stockCan = unsafeBitCast(method_getImplementation(can), to: CanPerform.self)
  let trimmedCan: @convention(block) (UIResponder, Selector, Any?) -> Bool = { view, action, sender in
    if view.inputView != nil,
       action == #selector(UIResponderStandardEditActions.cut(_:)) || action == #selector(UIResponderStandardEditActions.paste(_:)) {
      return false
    }
    return stockCan(view, canSel, action, sender)
  }
  class_replaceMethod(cls, canSel, imp_implementationWithBlock(trimmedCan), method_getTypeEncoding(can))

  typealias BuildMenu = @convention(c) (AnyObject, Selector, UIMenuBuilder) -> Void
  let stockBuild = unsafeBitCast(method_getImplementation(build), to: BuildMenu.self)
  let trimmedBuild: @convention(block) (UIResponder, UIMenuBuilder) -> Void = { view, builder in
    if view.inputView != nil, #available(iOS 17.0, *) {
      builder.remove(menu: .autoFill)
    }
    stockBuild(view, buildSel, builder)
  }
  class_replaceMethod(cls, buildSel, imp_implementationWithBlock(trimmedBuild), method_getTypeEncoding(build))
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
