import Foundation
import Security

// Fixed identity prevents callers from reading unrelated Keychain items.
let service = "com.lecture-transcriber.openai-api-key"
let account = "default"
let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account
]

func fail() -> Never {
    FileHandle.standardError.write(Data("Keychain operation failed.\n".utf8))
    exit(1)
}
func output(_ text: String) {
    FileHandle.standardOutput.write(Data(text.utf8))
}
guard CommandLine.arguments.count == 2 else { fail() }
let operation = CommandLine.arguments[1]
switch operation {
case "set":
    // The key is accepted only on stdin, never as an argument, environment variable or file.
    let input = FileHandle.standardInput.readData(ofLength: 4097)
    guard input.count <= 4096,
          let key = String(data: input, encoding: .utf8),
          key.range(of: "\\Ask-[A-Za-z0-9_-]{16,400}\\z", options: .regularExpression) != nil else { fail() }
    let attributes: [String: Any] = [kSecValueData as String: Data(key.utf8)]
    let updated = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
    if updated == errSecItemNotFound {
        var item = base
        item[kSecValueData as String] = Data(key.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { fail() }
    } else if updated != errSecSuccess { fail() }
case "get":
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { exit(0) }
    guard status == errSecSuccess, let data = result as? Data else { fail() }
    FileHandle.standardOutput.write(data)
case "status":
    var query = base
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { output("empty") }
    else if status == errSecSuccess { output("configured") }
    else { fail() }
case "delete":
    let status = SecItemDelete(base as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail() }
default:
    fail()
}
