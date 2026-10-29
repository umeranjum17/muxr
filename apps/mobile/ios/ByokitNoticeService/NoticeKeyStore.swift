import Foundation
import Security

struct NoticeKeyStore {
  let group: String
  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "byokit.notices",
     kSecAttrAccount as String: "device-secret", kSecAttrAccessGroup as String: group]
  }
  func set(_ key: Data) throws {
    guard key.count == 32 else { throw NoticeKeyError.invalid }
    // Update in place: a failed rotation must not first delete the working key.
    let attributes: [String: Any] = [kSecValueData as String: key,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) }
    guard status == errSecSuccess else { throw NoticeKeyError.unavailable }
  }
  func get() -> Data? {
    var result: CFTypeRef?
    let read = query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { _, new in new }
    guard SecItemCopyMatching(read as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data, data.count == 32 else { return nil }
    return data
  }
  func clear() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw NoticeKeyError.unavailable }
  }
}
enum NoticeKeyError: Error { case invalid, unavailable }
