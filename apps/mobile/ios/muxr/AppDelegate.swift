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
    disableSmartPunctuationWithAutocorrection()

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

// iOS rewrites the terminal composer as it is keyed: `--` turns into a dash and
// a straight quote into a curly one. React Native turns that off only through
// its `autoCorrect` prop — it has no smart-quotes or smart-dashes prop — and the
// linkage that made `autoCorrect={false}` also disable smart quotes and dashes
// lived in patches/react-native+0.83.1.patch. That patch never compiles: the app
// links prebuilt React Native core, so node_modules' RCTUITextView.mm and
// RCTUITextField.mm are never built. Reinstall the linkage at launch, so any
// input asked for autocorrection off also gets smart quotes and dashes off.
// Tied to React Native's private input classes: if an upgrade renames them or
// their method, do nothing and leave the stock behavior.
private func disableSmartPunctuationWithAutocorrection() {
  let setter = NSSelectorFromString("setAutocorrectionType:")
  typealias Setter = @convention(c) (AnyObject, Selector, UITextAutocorrectionType) -> Void
  for name in ["RCTUITextView", "RCTUITextField"] {
    guard let cls = NSClassFromString(name) else { continue }
    guard let stockIMP = class_getMethodImplementation(cls, setter) else { continue }
    let stock = unsafeBitCast(stockIMP, to: Setter.self)
    let linked: @convention(block) (AnyObject, UITextAutocorrectionType) -> Void = { view, correction in
      stock(view, setter, correction)
      let off = correction == UITextAutocorrectionType.no
      let quotes: UITextSmartQuotesType = off ? .no : .default
      let dashes: UITextSmartDashesType = off ? .no : .default
      if let field = view as? UITextField {
        field.smartQuotesType = quotes
        field.smartDashesType = dashes
      } else if let textView = view as? UITextView {
        textView.smartQuotesType = quotes
        textView.smartDashesType = dashes
      }
    }
    class_replaceMethod(cls, setter, imp_implementationWithBlock(linked), "v@:q")
  }
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
