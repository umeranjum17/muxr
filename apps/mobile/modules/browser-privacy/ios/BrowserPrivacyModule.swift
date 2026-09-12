import ExpoModulesCore
import UIKit

/**
 * Screen-capture and app-switcher cover while the agent browser is private.
 * iOS has no FLAG_SECURE; the best-effort equivalent is the secure text
 * field trick: the key window's layer is re-parented under a
 * `isSecureTextEntry` field's layer, which the system omits from screenshots,
 * recordings and the switcher snapshot. Removed on hand back. Picture in
 * picture is never requested for the private view.
 */
public final class BrowserPrivacyModule: Module {
  private var secureField: UITextField?
  private weak var originalSuperlayer: CALayer?

  public func definition() -> ModuleDefinition {
    Name("BrowserPrivacy")

    Function("setPrivate") { (active: Bool) -> Bool in
      DispatchQueue.main.async { [weak self] in
        if active { self?.cover() } else { self?.uncover() }
      }
      return true
    }

    OnDestroy {
      DispatchQueue.main.async { [weak self] in self?.uncover() }
    }
  }

  private var window: UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }

  // ponytail: the documented-nowhere secure-field layer trick; verify on
  // each iOS major and fall back to a plain cover view if it stops hiding.
  private func cover() {
    guard secureField == nil, let window, let superlayer = window.layer.superlayer else { return }
    let field = UITextField()
    field.isSecureTextEntry = true
    field.isUserInteractionEnabled = false
    window.addSubview(field)
    originalSuperlayer = superlayer
    superlayer.addSublayer(field.layer)
    field.layer.sublayers?.last?.addSublayer(window.layer)
    secureField = field
  }

  private func uncover() {
    guard let field = secureField else { return }
    if let window, let superlayer = originalSuperlayer { superlayer.addSublayer(window.layer) }
    field.layer.removeFromSuperlayer()
    field.removeFromSuperview()
    secureField = nil
    originalSuperlayer = nil
  }
}
