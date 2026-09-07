import AppKit
import Foundation
import UserNotifications

struct Options {
  var title = ""
  var message = ""
  var subtitle = ""
  var sound = false
  var check = false
  var openUrl = ""
}

func stderr(_ message: String) {
  FileHandle.standardError.write(Data((message + "\n").utf8))
}

func stdout(_ message: String) {
  FileHandle.standardOutput.write(Data((message + "\n").utf8))
}

func usage() -> Never {
  stderr("usage: aimux-notifier --title <title> --message <message> [--subtitle <subtitle>] [--open-url <aimux-url>] [--sound]")
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
    case "--open-url", "--deep-link":
      index += 1
      guard index < args.count else { usage() }
      options.openUrl = args[index]
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

func aimuxURL(_ raw: String) -> URL? {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
  guard url.scheme?.lowercased() == "aimux" else { return nil }
  return url
}

var activeNotificationDelegate: NotificationDelegate?

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

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer {
      completionHandler()
      NSApplication.shared.terminate(nil)
    }

    let userInfo = response.notification.request.content.userInfo
    guard let raw = userInfo["openUrl"] as? String, let url = aimuxURL(raw) else { return }
    NSWorkspace.shared.open(url)
  }
}

func installNotificationDelegate(_ center: UNUserNotificationCenter) {
  let delegate = NotificationDelegate()
  activeNotificationDelegate = delegate
  center.delegate = delegate
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
  let openUrl = options.openUrl.isEmpty ? nil : aimuxURL(options.openUrl)
  if !options.openUrl.isEmpty && openUrl == nil {
    stderr("--open-url must be an aimux: URL")
    return 64
  }

  NSApplication.shared.setActivationPolicy(.accessory)

  let center = UNUserNotificationCenter.current()
  installNotificationDelegate(center)

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
  if let openUrl {
    content.userInfo["openUrl"] = openUrl.absoluteString
  }
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
  return 0
}

func runNotificationResponseListener() -> Int32 {
  NSApplication.shared.setActivationPolicy(.accessory)
  let center = UNUserNotificationCenter.current()
  installNotificationDelegate(center)
  DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
    NSApplication.shared.terminate(nil)
  }
  NSApplication.shared.run()
  return 0
}

let cliArgs = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }
if cliArgs.isEmpty {
  exit(runNotificationResponseListener())
}

let options = parseArgs(cliArgs)

if options.check {
  exit(checkNotifier())
}

exit(postNotification(options))
