import AppKit
import Foundation
import UserNotifications

struct Options {
  var title = ""
  var message = ""
  var subtitle = ""
  var sound = false
  var check = false
}

func stderr(_ message: String) {
  FileHandle.standardError.write(Data((message + "\n").utf8))
}

func stdout(_ message: String) {
  FileHandle.standardOutput.write(Data((message + "\n").utf8))
}

func usage() -> Never {
  stderr("usage: aimux-notifier --title <title> --message <message> [--subtitle <subtitle>] [--sound]")
  exit(64)
}

func parseArgs(_ args: [String]) -> Options {
  var options = Options()
  var index = 0

  while index < args.count {
    let arg = args[index]
    switch arg {
    case "--title":
      index += 1
      guard index < args.count else { usage() }
      options.title = args[index]
    case "--message", "--body":
      index += 1
      guard index < args.count else { usage() }
      options.message = args[index]
    case "--subtitle":
      index += 1
      guard index < args.count else { usage() }
      options.subtitle = args[index]
    case "--sound":
      options.sound = true
    case "--check":
      options.check = true
    case "--help", "-h":
      usage()
    default:
      stderr("unknown option: \(arg)")
      usage()
    }
    index += 1
  }

  return options
}

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if #available(macOS 11.0, *) {
      completionHandler([.banner, .list, .sound])
    } else {
      completionHandler([.alert, .sound])
    }
  }
}

func authorizationStatusName(_ status: UNAuthorizationStatus) -> String {
  switch status {
  case .notDetermined:
    return "notDetermined"
  case .denied:
    return "denied"
  case .authorized:
    return "authorized"
  case .provisional:
    return "provisional"
  case .ephemeral:
    return "ephemeral"
  @unknown default:
    return "unknown"
  }
}

func notificationSettings(_ center: UNUserNotificationCenter) -> UNNotificationSettings? {
  let semaphore = DispatchSemaphore(value: 0)
  var result: UNNotificationSettings?
  center.getNotificationSettings { settings in
    result = settings
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 5) == .timedOut {
    return nil
  }
  return result
}

func requestAuthorization(_ center: UNUserNotificationCenter) -> Bool {
  let semaphore = DispatchSemaphore(value: 0)
  var granted = false
  var requestError: Error?
  center.requestAuthorization(options: [.alert, .sound]) { ok, error in
    granted = ok
    requestError = error
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 10) == .timedOut {
    stderr("notification authorization timed out")
    return false
  }
  if let requestError {
    stderr("notification authorization failed: \(requestError.localizedDescription)")
  }
  return granted
}

func checkNotifier() -> Int32 {
  let bundleId = Bundle.main.bundleIdentifier ?? "unknown"
  let center = UNUserNotificationCenter.current()
  guard let settings = notificationSettings(center) else {
    stderr("Aimux notifier check failed (\(bundleId)): notification settings timed out")
    return 75
  }
  stdout("Aimux notifier ready (\(bundleId)); authorization=\(authorizationStatusName(settings.authorizationStatus))")
  return settings.authorizationStatus == .denied ? 77 : 0
}

func postNotification(_ options: Options) -> Int32 {
  guard !options.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    stderr("missing --title")
    return 64
  }
  guard !options.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    stderr("missing --message")
    return 64
  }

  NSApplication.shared.setActivationPolicy(.accessory)

  let center = UNUserNotificationCenter.current()
  let delegate = NotificationDelegate()
  center.delegate = delegate

  if let settings = notificationSettings(center) {
    if settings.authorizationStatus == .denied {
      stderr("notifications are denied for \(Bundle.main.bundleIdentifier ?? "unknown")")
      return 77
    }
    if settings.authorizationStatus == .notDetermined && !requestAuthorization(center) {
      stderr("notifications are not authorized for \(Bundle.main.bundleIdentifier ?? "unknown")")
      return 77
    }
  } else {
    stderr("notification settings timed out")
    return 75
  }

  let content = UNMutableNotificationContent()
  content.title = options.title
  if !options.subtitle.isEmpty {
    content.subtitle = options.subtitle
  }
  content.body = options.message
  if options.sound {
    content.sound = .default
  }

  let request = UNNotificationRequest(identifier: "aimux-\(UUID().uuidString)", content: content, trigger: nil)
  let semaphore = DispatchSemaphore(value: 0)
  var deliveryError: Error?
  center.add(request) { error in
    deliveryError = error
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 5) == .timedOut {
    stderr("notification delivery timed out")
    return 75
  }
  if let deliveryError {
    stderr("notification delivery failed: \(deliveryError.localizedDescription)")
    return 70
  }

  Thread.sleep(forTimeInterval: 1.0)
  _ = delegate
  return 0
}

let options = parseArgs(Array(CommandLine.arguments.dropFirst()))

if options.check {
  exit(checkNotifier())
}

exit(postNotification(options))
