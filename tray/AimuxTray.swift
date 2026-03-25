import AppKit
import Foundation

// MARK: - Data Models

struct ServerStatus: Decodable {
    struct ServerInfo: Decodable {
        let pid: Int
        let uptime: Int
        let clientConnected: Bool
    }
    struct Session: Decodable {
        let id: String
        let tool: String
        let status: String
        let label: String?
        let worktreePath: String?
    }
    struct OfflineSession: Decodable {
        let id: String
        let tool: String
        let label: String?
        let worktreePath: String?
    }
    let server: ServerInfo
    let mode: String
    let sessions: [Session]
    let offlineSessions: [OfflineSession]
}

// MARK: - API Client

class AimuxAPI {
    private let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    private var apiSocketPath: String { "\(homeDir)/.aimux/aimux-api.sock" }
    private var pidPath: String { "\(homeDir)/.aimux/aimux.pid" }

    func isServerRunning() -> Bool {
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return false
        }
        return kill(Int32(pid), 0) == 0
    }

    func getServerPid() -> Int? {
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)),
              kill(Int32(pid), 0) == 0 else { return nil }
        return pid
    }

    /// Query the server's HTTP API via Unix socket
    func fetchStatus() -> ServerStatus? {
        guard isServerRunning() else { return nil }

        // Connect to Unix domain socket and make HTTP request
        let socket = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socket >= 0 else { return nil }
        defer { close(socket) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = apiSocketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            pathBytes.withUnsafeBufferPointer { buf in
                memcpy(ptr, buf.baseAddress!, buf.count)
            }
        }

        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.connect(socket, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else { return nil }

        // Send HTTP request
        let request = "GET /status HTTP/1.0\r\nHost: localhost\r\n\r\n"
        _ = request.withCString { Darwin.write(socket, $0, strlen($0)) }

        // Read response
        var response = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = Darwin.read(socket, &buf, buf.count)
            if n <= 0 { break }
            response.append(contentsOf: buf[0..<n])
        }

        // Parse HTTP response — find JSON body after \r\n\r\n
        guard let responseStr = String(data: response, encoding: .utf8),
              let bodyRange = responseStr.range(of: "\r\n\r\n") else { return nil }
        let body = String(responseStr[bodyRange.upperBound...])
        guard let jsonData = body.data(using: .utf8) else { return nil }

        return try? JSONDecoder().decode(ServerStatus.self, from: jsonData)
    }
}

// MARK: - Status Display Helpers

extension ServerStatus.Session {
    var statusIcon: String {
        switch status {
        case "running": return "\u{1F7E1}" // yellow
        case "idle": return "\u{1F7E2}"    // green
        case "waiting": return "\u{1F535}" // blue
        default: return "\u{26AB}"
        }
    }
    var displayLabel: String {
        if let label = label, !label.isEmpty { return "\(tool) — \(label)" }
        return tool
    }
}

// MARK: - Node/Aimux Path Resolution

func findNodeBinary() -> String {
    let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    let nvmDir = "\(homeDir)/.nvm/versions/node"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
        for ver in versions.sorted().reversed() {
            let path = "\(nvmDir)/\(ver)/bin/node"
            if FileManager.default.fileExists(atPath: path) { return path }
        }
    }
    if FileManager.default.fileExists(atPath: "/opt/homebrew/bin/node") {
        return "/opt/homebrew/bin/node"
    }
    return "/usr/local/bin/node"
}

func findAimuxMain() -> String {
    return "\(FileManager.default.homeDirectoryForCurrentUser.path)/cs/aimux/dist/main.js"
}

func findAimuxBinary() -> String {
    let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    let binLink = "\(homeDir)/bin/aimux"
    if FileManager.default.fileExists(atPath: binLink) { return binLink }
    return "aimux"
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var api = AimuxAPI()
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.updateMenu()
        }
    }

    func updateMenu() {
        let serverRunning = api.isServerRunning()
        let status = api.fetchStatus()
        let menu = NSMenu()

        // Update icon
        let runningCount = status?.sessions.count ?? 0
        let offlineCount = status?.offlineSessions.count ?? 0

        if let button = statusItem.button {
            if runningCount > 0 {
                button.title = " \(runningCount)"
                button.image = createDot(color: .systemGreen)
            } else if serverRunning {
                button.title = ""
                button.image = createDot(color: .systemGreen)
            } else if offlineCount > 0 {
                button.title = " \(offlineCount)"
                button.image = createDot(color: .systemGray)
            } else {
                button.title = ""
                button.image = createDot(color: .systemGray)
            }
            button.image?.isTemplate = false
        }

        // Server status
        if let status = status {
            let uptime = formatUptime(status.server.uptime)
            let clientStr = status.server.clientConnected ? " (client attached)" : ""
            let item = NSMenuItem(title: "Server PID \(status.server.pid) \u{2022} \(uptime)\(clientStr)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)

            let stopItem = NSMenuItem(title: "Stop Server", action: #selector(stopServer), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
        } else if serverRunning {
            let item = NSMenuItem(title: "Server running (PID \(api.getServerPid() ?? 0))", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            let stopItem = NSMenuItem(title: "Stop Server", action: #selector(stopServer), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
        } else {
            let item = NSMenuItem(title: "Server not running", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            let startItem = NSMenuItem(title: "Start Server", action: #selector(startServer), keyEquivalent: "")
            startItem.target = self
            menu.addItem(startItem)
        }

        menu.addItem(NSMenuItem.separator())

        // Sessions from API
        if let status = status {
            if status.sessions.isEmpty && status.offlineSessions.isEmpty {
                let item = NSMenuItem(title: "No agents", action: nil, keyEquivalent: "")
                item.isEnabled = false
                menu.addItem(item)
            } else {
                // Running sessions
                for session in status.sessions {
                    let title = "  \(session.statusIcon) \(session.displayLabel)"
                    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                    item.isEnabled = false
                    menu.addItem(item)
                }

                // Offline sessions
                for session in status.offlineSessions {
                    let label = session.label ?? session.tool
                    let title = "  \u{26AA} \(label)"
                    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                    item.isEnabled = false
                    menu.addItem(item)
                }
            }
        } else {
            let item = NSMenuItem(title: "No agents", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(NSMenuItem.separator())

        // Attach
        if serverRunning {
            let attachItem = NSMenuItem(title: "Attach in Terminal", action: #selector(attachInTerminal), keyEquivalent: "a")
            attachItem.target = self
            menu.addItem(attachItem)
            menu.addItem(NSMenuItem.separator())
        }

        let quitItem = NSMenuItem(title: "Quit Tray", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    private func createDot(color: NSColor) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size)
        image.lockFocus()
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: 4, y: 4, width: 8, height: 8)).fill()
        image.unlockFocus()
        return image
    }

    private func formatUptime(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
    }

    private func runAimux(_ args: [String], wait: Bool = false) {
        let node = findNodeBinary()
        let mainJs = findAimuxMain()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = [mainJs] + args
        task.environment = ProcessInfo.processInfo.environment
        try? task.run()
        if wait { task.waitUntilExit() }
    }

    @objc func startServer() {
        runAimux(["server", "start"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.updateMenu()
        }
    }

    @objc func stopServer() {
        runAimux(["server", "stop"], wait: true)
        updateMenu()
    }

    @objc func attachInTerminal() {
        let aimux = findAimuxBinary()
        let script = """
        tell application "Terminal"
            activate
            do script "\(aimux) attach"
        end tell
        """
        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
        }
    }

    @objc func quitApp() {
        NSApplication.shared.terminate(nil)
    }
}

// MARK: - Main

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
