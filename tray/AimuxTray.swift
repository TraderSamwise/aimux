import AppKit
import Foundation

// MARK: - Data Models

struct AimuxSession {
    let id: String
    let tool: String
    let status: String // "running", "idle", "waiting", "offline"
    let label: String?
    let worktreePath: String?
    let pid: Int?
}

struct AimuxProject {
    let path: String
    let name: String
    let sessions: [AimuxSession]
}

// MARK: - File Scanner

/// Resolve aimux binary path — GUI apps don't inherit shell PATH
func findAimuxBinary() -> String {
    let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    // Check ~/bin/aimux symlink first
    let binLink = "\(homeDir)/bin/aimux"
    if FileManager.default.fileExists(atPath: binLink) {
        return binLink
    }
    // Check common nvm locations
    let nvmDir = "\(homeDir)/.nvm/versions/node"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
        for ver in versions.sorted().reversed() {
            let path = "\(nvmDir)/\(ver)/bin/aimux"
            if FileManager.default.fileExists(atPath: path) { return path }
        }
    }
    // Fallback
    return "aimux"
}

/// Resolve node binary path for GUI context
func findNodeBinary() -> String {
    let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    let nvmDir = "\(homeDir)/.nvm/versions/node"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
        for ver in versions.sorted().reversed() {
            let path = "\(nvmDir)/\(ver)/bin/node"
            if FileManager.default.fileExists(atPath: path) { return path }
        }
    }
    // Check homebrew
    if FileManager.default.fileExists(atPath: "/opt/homebrew/bin/node") {
        return "/opt/homebrew/bin/node"
    }
    return "/usr/local/bin/node"
}

class AimuxScanner {
    private let homeDir = FileManager.default.homeDirectoryForCurrentUser.path

    /// Scan all known aimux state to build a global picture
    func scan() -> (projects: [AimuxProject], serverRunning: Bool, serverPid: Int?) {
        let serverRunning = isServerRunning()
        let serverPid = getServerPid()

        // Collect projects from instances.json files and state.json
        var projectMap: [String: [AimuxSession]] = [:]

        // Check global ~/.aimux/
        scanDir(join(homeDir, ".aimux"), into: &projectMap)

        // Also scan recently known project dirs from instances
        let instanceProjects = getInstanceProjects()
        for projectPath in instanceProjects {
            let aimuxDir = join(projectPath, ".aimux")
            scanDir(aimuxDir, into: &projectMap)
        }

        let projects = projectMap.map { (path, sessions) -> AimuxProject in
            let name = URL(fileURLWithPath: path).lastPathComponent
            return AimuxProject(path: path, name: name, sessions: sessions)
        }.sorted { $0.name < $1.name }

        return (projects, serverRunning, serverPid)
    }

    private func scanDir(_ aimuxDir: String, into projectMap: inout [String: [AimuxSession]]) {
        // Read instances.json for running sessions
        let instancesPath = join(aimuxDir, "instances.json")
        if let data = try? Data(contentsOf: URL(fileURLWithPath: instancesPath)),
           let instances = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            for inst in instances {
                guard let pid = inst["pid"] as? Int,
                      isProcessAlive(pid),
                      let sessions = inst["sessions"] as? [[String: Any]],
                      let cwd = inst["cwd"] as? String else { continue }

                for s in sessions {
                    let session = AimuxSession(
                        id: s["id"] as? String ?? "unknown",
                        tool: s["tool"] as? String ?? "unknown",
                        status: "running",
                        label: readStatusFile(aimuxDir: aimuxDir, sessionId: s["id"] as? String ?? ""),
                        worktreePath: s["worktreePath"] as? String,
                        pid: pid
                    )
                    let project = s["worktreePath"] as? String ?? cwd
                    projectMap[project, default: []].append(session)
                }
            }
        }

        // Read state.json for offline sessions
        let statePath = join(aimuxDir, "state.json")
        if let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
           let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let sessions = state["sessions"] as? [[String: Any]],
           let cwd = state["cwd"] as? String {
            let existingIds = Set(projectMap.values.flatMap { $0 }.map { $0.id })
            for s in sessions {
                let sid = s["id"] as? String ?? "unknown"
                if existingIds.contains(sid) { continue }
                let session = AimuxSession(
                    id: sid,
                    tool: s["command"] as? String ?? "unknown",
                    status: "offline",
                    label: s["label"] as? String,
                    worktreePath: s["worktreePath"] as? String,
                    pid: nil
                )
                let project = s["worktreePath"] as? String ?? cwd
                projectMap[project, default: []].append(session)
            }
        }
    }

    private func readStatusFile(aimuxDir: String, sessionId: String) -> String? {
        let statusPath = join(aimuxDir, "status", "\(sessionId).md")
        guard let content = try? String(contentsOfFile: statusPath, encoding: .utf8) else { return nil }
        let firstLine = content.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n").first ?? ""
        return firstLine.isEmpty ? nil : String(firstLine.prefix(60))
    }

    private func getInstanceProjects() -> [String] {
        let globalInstances = join(homeDir, ".aimux", "instances.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: globalInstances)),
              let instances = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return instances.compactMap { $0["cwd"] as? String }
    }

    func isServerRunning() -> Bool {
        let pidPath = join(homeDir, ".aimux", "aimux.pid")
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return false
        }
        return isProcessAlive(pid)
    }

    func getServerPid() -> Int? {
        let pidPath = join(homeDir, ".aimux", "aimux.pid")
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)),
              isProcessAlive(pid) else {
            return nil
        }
        return pid
    }

    private func isProcessAlive(_ pid: Int) -> Bool {
        kill(Int32(pid), 0) == 0
    }

    private func join(_ components: String...) -> String {
        (components as NSArray).componentsJoined(by: "/")
            .replacingOccurrences(of: "//", with: "/")
    }
}

// MARK: - Status Icons

extension AimuxSession {
    var statusIcon: String {
        switch status {
        case "running": return "\u{1F7E1}" // yellow circle
        case "idle": return "\u{1F7E2}"    // green circle
        case "waiting": return "\u{1F535}" // blue circle
        case "offline": return "\u{26AA}"  // white circle
        default: return "\u{26AB}"         // black circle
        }
    }

    var displayLabel: String {
        if let label = label {
            return "\(tool) - \(label)"
        }
        return tool
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var scanner = AimuxScanner()
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateMenu()

        // Poll every 5 seconds
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.updateMenu()
        }
    }

    func updateMenu() {
        let (projects, serverRunning, serverPid) = scanner.scan()

        // Update icon
        let totalRunning = projects.flatMap { $0.sessions }.filter { $0.status != "offline" }.count
        let totalOffline = projects.flatMap { $0.sessions }.filter { $0.status == "offline" }.count

        if let button = statusItem.button {
            if totalRunning > 0 {
                button.title = " \(totalRunning)"
                button.image = createDot(color: .systemGreen)
            } else if serverRunning {
                button.title = ""
                button.image = createDot(color: .systemGreen)
            } else if totalOffline > 0 {
                button.title = " \(totalOffline)"
                button.image = createDot(color: .systemGray)
            } else {
                button.title = ""
                button.image = createDot(color: .systemGray)
            }
            button.image?.isTemplate = false
        }

        // Build menu
        let menu = NSMenu()

        // Server status
        if serverRunning {
            let serverItem = NSMenuItem(title: "Server running (PID \(serverPid ?? 0))", action: nil, keyEquivalent: "")
            serverItem.isEnabled = false
            menu.addItem(serverItem)

            let stopItem = NSMenuItem(title: "Stop Server", action: #selector(stopServer), keyEquivalent: "")
            stopItem.target = self
            menu.addItem(stopItem)
        } else {
            let serverItem = NSMenuItem(title: "Server not running", action: nil, keyEquivalent: "")
            serverItem.isEnabled = false
            menu.addItem(serverItem)

            let startItem = NSMenuItem(title: "Start Server", action: #selector(startServer), keyEquivalent: "")
            startItem.target = self
            menu.addItem(startItem)
        }

        menu.addItem(NSMenuItem.separator())

        // Projects and sessions
        if projects.isEmpty || projects.allSatisfy({ $0.sessions.isEmpty }) {
            let emptyItem = NSMenuItem(title: "No agents", action: nil, keyEquivalent: "")
            emptyItem.isEnabled = false
            menu.addItem(emptyItem)
        } else {
            for project in projects where !project.sessions.isEmpty {
                // Project header
                let header = NSMenuItem(title: project.name, action: nil, keyEquivalent: "")
                header.isEnabled = false
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.boldSystemFont(ofSize: 13),
                ]
                header.attributedTitle = NSAttributedString(string: project.name, attributes: attrs)
                menu.addItem(header)

                // Sessions
                for session in project.sessions {
                    let title = "  \(session.statusIcon) \(session.displayLabel)"
                    let item = NSMenuItem(title: title, action: #selector(openTerminal(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = project.path
                    menu.addItem(item)
                }

                menu.addItem(NSMenuItem.separator())
            }
        }

        // Attach
        if serverRunning {
            let attachItem = NSMenuItem(title: "Attach in Terminal", action: #selector(attachInTerminal), keyEquivalent: "a")
            attachItem.target = self
            menu.addItem(attachItem)
            menu.addItem(NSMenuItem.separator())
        }

        // Quit
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
        let rect = NSRect(x: 4, y: 4, width: 8, height: 8)
        NSBezierPath(ovalIn: rect).fill()
        image.unlockFocus()
        return image
    }

    /// Run an aimux command using node directly (bypasses shebang PATH issues)
    private func runAimux(_ args: [String], wait: Bool = false) {
        let node = findNodeBinary()
        let mainJs = "\(FileManager.default.homeDirectoryForCurrentUser.path)/cs/aimux/dist/main.js"
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

    @objc func openTerminal(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        let aimux = findAimuxBinary()
        let script = """
        tell application "Terminal"
            activate
            do script "cd '\(path)' && \(aimux)"
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
app.setActivationPolicy(.accessory) // No dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
