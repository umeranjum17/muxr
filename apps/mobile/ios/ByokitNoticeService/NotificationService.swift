import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var completion: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?
  override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
    completion = handler
    fallback = request.content
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
          let group = Bundle.main.object(forInfoDictionaryKey: "ByokitNoticeAppGroup") as? String,
          var key = NoticeKeyStore(group: group).get() else { finish(request.content); return }
    defer { key.resetBytes(in: 0..<key.count) }
    if let opened = NoticePayload.openTransport(content.userInfo, key: key) {
      content.title = opened.title
      content.body = opened.body
      // Match muxr's notification response: userInfo.data contains the original routing fields.
      if let data = opened.data {
        content.userInfo["data"] = data
        // Expo serializes remote custom data from userInfo.body.
        var expoData = content.userInfo["body"] as? [String: Any] ?? [:]
        expoData["data"] = data
        content.userInfo["body"] = expoData
      }
      finish(content)
    } else { finish(request.content) }
  }
  override func serviceExtensionTimeWillExpire() { if let fallback { finish(fallback) } }
  private func finish(_ content: UNNotificationContent) {
    let handler = completion
    completion = nil
    handler?(content)
  }
}
