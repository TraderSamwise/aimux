import AppKit
import Foundation

// MARK: - Data Models

struct AimuxSession {
    let id: String
    let tool: String
    let status: String
    let label: String?
    let worktreePath: String?
    let projectPath: String
}

// MARK: - File Scanner

class AimuxScanner {
    private let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    private var knownProjects = Set<String>()

    /// Scan all known aimux state from file-based coordination files
    func scan() -> (sessions: [AimuxSession], serverPid: Int?) {
        var sessions: [AimuxSession] = []
        var seenIds = Set<String>()

        // Discover projects from known list + recent scans
        discoverProjects()

        // Scan each project's .aimux/ for instances.json + state.json
        for projectPath in knownProjects {
            let aimuxDir = "\(projectPath)/.aimux"

            // Running sessions from instances.json
            let instancesPath = "\(aimuxDir)/instances.json"
            if let data = try? Data(contentsOf: URL(fileURLWithPath: instancesPath)),
               let instances = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                for inst in instances {
                    guard let pid = inst["pid"] as? Int, isAlive(pid),
                          let instSessions = inst["sessions"] as? [[String: Any]] else { continue }

                    for s in instSessions {
                        let sid = s["id"] as? String ?? "unknown"
                        if seenIds.contains(sid) { continue }
                        seenIds.insert(sid)

                        let label = readStatusFile(aimuxDir: aimuxDir, sessionId: sid)
                        sessions.append(AimuxSession(
                            id: sid,
                            tool: s["tool"] as? String ?? "unknown",
                            status: "running",
                            label: label,
                            worktreePath: s["worktreePath"] as? String,
                            projectPath: projectPath
                        ))
                    }
                }
            }

            // Offline sessions from state.json
            let statePath = "\(aimuxDir)/state.json"
            if let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
               let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let stateSessions = state["sessions"] as? [[String: Any]] {
                for s in stateSessions {
                    let sid = s["id"] as? String ?? "unknown"
                    if seenIds.contains(sid) { continue }
                    seenIds.insert(sid)

                    sessions.append(AimuxSession(
                        id: sid,
                        tool: s["command"] as? String ?? s["tool"] as? String ?? "unknown",
                        status: "offline",
                        label: s["label"] as? String,
                        worktreePath: s["worktreePath"] as? String,
                        projectPath: projectPath
                    ))
                }
            }
        }

        let serverPid = getServerPid()
        return (sessions, serverPid)
    }

    private func discoverProjects() {
        // Check global ~/.aimux/ for a known-projects breadcrumb
        let knownPath = "\(homeDir)/.aimux/known-projects.txt"
        if let content = try? String(contentsOfFile: knownPath, encoding: .utf8) {
            for line in content.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty && FileManager.default.fileExists(atPath: "\(trimmed)/.aimux") {
                    knownProjects.insert(trimmed)
                }
            }
        }

        // Also scan common dev dirs for .aimux/
        let scanDirs = ["\(homeDir)/cs", "\(homeDir)/projects", "\(homeDir)/dev", "\(homeDir)/src"]
        for scanDir in scanDirs {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: scanDir) else { continue }
            for entry in entries {
                let projectPath = "\(scanDir)/\(entry)"
                if FileManager.default.fileExists(atPath: "\(projectPath)/.aimux/instances.json") ||
                   FileManager.default.fileExists(atPath: "\(projectPath)/.aimux/state.json") {
                    knownProjects.insert(projectPath)
                }
            }
        }
    }

    private func readStatusFile(aimuxDir: String, sessionId: String) -> String? {
        let path = "\(aimuxDir)/status/\(sessionId).md"
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let firstLine = content.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n").first ?? ""
        return firstLine.isEmpty ? nil : String(firstLine.prefix(60))
    }

    func isServerRunning() -> Bool {
        return getServerPid() != nil
    }

    func getServerPid() -> Int? {
        let pidPath = "\(homeDir)/.aimux/aimux.pid"
        guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)),
              isAlive(pid) else { return nil }
        return pid
    }

    private func isAlive(_ pid: Int) -> Bool {
        kill(Int32(pid), 0) == 0
    }
}

// MARK: - Path Resolution

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
    private var scanner = AimuxScanner()
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.updateMenu()
        }
    }

    func updateMenu() {
        let (sessions, serverPid) = scanner.scan()
        let serverRunning = serverPid != nil
        let running = sessions.filter { $0.status != "offline" }
        let offline = sessions.filter { $0.status == "offline" }
        let menu = NSMenu()

        // Icon
        if let button = statusItem.button {
            if !running.isEmpty {
                button.title = " \(running.count)"
                button.image = createDot(color: .systemGreen)
            } else if serverRunning {
                button.title = ""
                button.image = createDot(color: .systemGreen)
            } else if !offline.isEmpty {
                button.title = " \(offline.count)"
                button.image = createDot(color: .systemGray)
            } else {
                button.title = ""
                button.image = createDot(color: .systemGray)
            }
            button.image?.isTemplate = false
        }

        // Server
        if serverRunning {
            let item = NSMenuItem(title: "Server running (PID \(serverPid!))", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            let stop = NSMenuItem(title: "Stop Server", action: #selector(stopServer), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)
        } else {
            let item = NSMenuItem(title: "Server not running", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            let start = NSMenuItem(title: "Start Server", action: #selector(startServer), keyEquivalent: "")
            start.target = self
            menu.addItem(start)
        }

        menu.addItem(NSMenuItem.separator())

        // Group by project
        let grouped = Dictionary(grouping: sessions) { URL(fileURLWithPath: $0.projectPath).lastPathComponent }
        if grouped.isEmpty {
            let item = NSMenuItem(title: "No agents", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            for (project, projectSessions) in grouped.sorted(by: { $0.key < $1.key }) {
                // Project header
                let header = NSMenuItem(title: project, action: nil, keyEquivalent: "")
                header.isEnabled = false
                header.attributedTitle = NSAttributedString(
                    string: project,
                    attributes: [.font: NSFont.boldSystemFont(ofSize: 13)]
                )
                menu.addItem(header)

                for session in projectSessions {
                    let icon: String
                    switch session.status {
                    case "running": icon = "\u{1F7E1}"
                    case "idle": icon = "\u{1F7E2}"
                    case "waiting": icon = "\u{1F535}"
                    default: icon = "\u{26AA}"
                    }
                    let detail = session.label != nil ? "\(session.tool) — \(session.label!)" : session.tool
                    let title = "  \(icon) \(detail)"
                    let item = NSMenuItem(title: title, action: #selector(openProject(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = session.projectPath
                    menu.addItem(item)
                }
            }
        }

        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(title: "Quit Tray", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

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

    private func runAimux(_ args: [String], wait: Bool = false) {
        let node = findNodeBinary()
        let mainJs = findAimuxMain()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = [mainJs] + args
        try? task.run()
        if wait { task.waitUntilExit() }
    }

    @objc func startServer() {
        runAimux(["server", "start"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.updateMenu() }
    }

    @objc func stopServer() {
        runAimux(["server", "stop"], wait: true)
        updateMenu()
    }

    @objc func openProject(_ sender: NSMenuItem) {
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
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
