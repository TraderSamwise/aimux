import AppKit
import Foundation

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

// This helper is executed directly from the app bundle by the CLI. The modern
// UserNotifications API rejects that launch mode; this is the same legacy API
// shape used by terminal-notifier, but under Aimux's bundle identity.
final class NotificationDelegate: NSObject, NSUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: NSUserNotificationCenter,
    shouldPresent notification: NSUserNotification
  ) -> Bool {
    return true
  }
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

  let center = NSUserNotificationCenter.default
  let delegate = NotificationDelegate()
  center.delegate = delegate

  let notification = NSUserNotification()
  notification.identifier = "aimux-\(UUID().uuidString)"
  notification.title = options.title
  notification.subtitle = options.subtitle.isEmpty ? nil : options.subtitle
  notification.informativeText = options.message
  if options.sound {
    notification.soundName = NSUserNotificationDefaultSoundName
  }

  center.deliver(notification)
  Thread.sleep(forTimeInterval: 0.2)
  _ = delegate
  return 0
}

let options = parseArgs(Array(CommandLine.arguments.dropFirst()))

if options.check {
  let bundleId = Bundle.main.bundleIdentifier ?? "unknown"
  stdout("Aimux notifier ready (\(bundleId))")
  exit(0)
}

exit(postNotification(options))
