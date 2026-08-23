import ExpoModulesCore
import UIKit

private struct ShortcutRecord: Record {
  @Field var id: String = ""
  @Field var label: String = ""
  @Field var longLabel: String = ""
}

/** Generic iOS quick-action projection of the approved runtime plugin catalog. */
public final class PluginShortcutsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PluginShortcuts")

    Function("setShortcuts") { (shortcuts: [ShortcutRecord], bakedIds: [String]) -> Bool in
      let apply = {
        let baked = Set(bakedIds)
        UIApplication.shared.shortcutItems = shortcuts
          .filter { !baked.contains($0.id) && !$0.id.isEmpty && !$0.label.isEmpty }
          .prefix(max(0, 4 - baked.count))
          .map { shortcut in
            UIApplicationShortcutItem(
              type: shortcut.id,
              localizedTitle: shortcut.label,
              localizedSubtitle: shortcut.longLabel.isEmpty ? shortcut.label : shortcut.longLabel,
              icon: UIApplicationShortcutIcon(type: .play),
              userInfo: nil
            )
          }
      }
      if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
      return true
    }
  }
}

/** Convert an iOS quick action into the same deep link Android shortcuts use. */
public final class PluginShortcutAppDelegateSubscriber: ExpoAppDelegateSubscriber {
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
