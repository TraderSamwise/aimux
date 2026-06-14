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
  let semaphore = DispatchSemaphore(value: 0)
  var exitCode: Int32 = 0

  center.requestAuthorization(options: [.alert, .sound]) { granted, error in
    if let error {
      stderr("notification authorization failed: \(error.localizedDescription)")
      exitCode = 1
      semaphore.signal()
      return
    }

    guard granted else {
      stderr("notification authorization denied")
      exitCode = 2
      semaphore.signal()
      return
    }

    let content = UNMutableNotificationContent()
    content.title = options.title
    content.subtitle = options.subtitle
    content.body = options.message
    if options.sound {
      content.sound = .default
    }

    let request = UNNotificationRequest(identifier: "aimux-\(UUID().uuidString)", content: content, trigger: nil)
    center.add(request) { error in
      if let error {
        stderr("notification delivery failed: \(error.localizedDescription)")
        exitCode = 1
      }
      semaphore.signal()
    }
  }

  if semaphore.wait(timeout: .now() + 10) == .timedOut {
    stderr("notification delivery timed out")
    return 1
  }

  return exitCode
}

let options = parseArgs(Array(CommandLine.arguments.dropFirst()))

if options.check {
  let bundleId = Bundle.main.bundleIdentifier ?? "unknown"
  stdout("Aimux notifier ready (\(bundleId))")
  exit(0)
}

exit(postNotification(options))
