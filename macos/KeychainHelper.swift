import Foundation
import Security
import Darwin

let service = "org.clipassistant.user-secret.v1"
let arguments = CommandLine.arguments

func fail(_ message: String, _ status: OSStatus = errSecParam) -> Never {
    FileHandle.standardError.write(Data("\(message) (\(status))\n".utf8))
    exit(1)
}

guard arguments.count == 3 else { fail("KEYCHAIN_INVALID_ARGUMENTS") }
let action = arguments[1]
let account = arguments[2]
guard ["get", "set", "delete"].contains(action),
      account.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
    fail("KEYCHAIN_INVALID_ARGUMENTS")
}

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

switch action {
case "get":
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true], uniquingKeysWith: { _, new in new }) as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else { fail("KEYCHAIN_READ_FAILED", status) }
    FileHandle.standardOutput.write(data)
case "set":
    let value = FileHandle.standardInput.readDataToEndOfFile()
    guard !value.isEmpty, value.count <= 1_048_576 else { fail("KEYCHAIN_INVALID_VALUE") }
    let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: value] as CFDictionary)
    if update == errSecItemNotFound {
        let add = query.merging([kSecValueData as String: value], uniquingKeysWith: { _, new in new })
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { fail("KEYCHAIN_WRITE_FAILED", status) }
    } else if update != errSecSuccess {
        fail("KEYCHAIN_WRITE_FAILED", update)
    }
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { fail("KEYCHAIN_DELETE_FAILED", status) }
default:
    fail("KEYCHAIN_INVALID_ARGUMENTS")
}
