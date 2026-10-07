import ExpoModulesCore
import UIKit

/** Convert the baked voice quick action into the same deep link Android's shortcut uses. */
public final class VoiceShortcutAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    var components = URLComponents()
    components.scheme = "muxr"
    components.host = "shortcut"
    components.path = "/\(shortcutItem.type)"
    guard let url = components.url else {
      completionHandler(false)
      return
    }
    application.open(url, options: [:]) { opened in completionHandler(opened) }
  }
}
