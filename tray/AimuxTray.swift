import AppKit
import Foundation

// MARK: - Data Models

struct AgentSession {
    let id: String
    let tool: String
    let label: String?
    let headline: String?
    let status: String       // "idle", "running", "waiting", "error", "offline"
    let role: String?        // "coder", "reviewer", etc.
    let isServer: Bool       // owned by headless server vs direct TUI
    let projectName: String
    let projectPath: String
}

struct ProjectEntry {
    let id: String
    let name: String
    let repoRoot: String
    let serverRunning: Bool
}

final class ProjectActionTarget: NSObject {
    let project: ProjectEntry
    let shouldStart: Bool

    init(project: ProjectEntry, shouldStart: Bool) {
        self.project = project
        self.shouldStart = shouldStart
    }
}

// MARK: - File Scanner

class ProjectScanner {
    private let homeDir = FileManager.default.homeDirectoryForCurrentUser.path

    func scan() -> [AgentSession] {
        var sessions: [AgentSession] = []

        // Primary: read ~/.aimux/projects.json registry
        sessions.append(contentsOf: scanRegisteredProjects())

        // Fallback: scan old .aimux/ dirs for projects not yet migrated
        sessions.append(contentsOf: scanLegacyAimux(excluding: Set(sessions.map { $0.projectPath })))

        return sessions
    }

    func scanProjects() -> [ProjectEntry] {
        let registryPath = "\(homeDir)/.aimux/projects.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: registryPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let projects = json["projects"] as? [[String: Any]] else {
            return []
        }

        return projects.compactMap { project in
            guard let id = project["id"] as? String,
                  let name = project["name"] as? String,
                  let repoRoot = project["repoRoot"] as? String else { return nil }
            let pidPath = "\(homeDir)/.aimux/projects/\(id)/aimux.pid"
            return ProjectEntry(
                id: id,
                name: name,
                repoRoot: repoRoot,
                serverRunning: isServerRunning(pidPath: pidPath)
            )
        }
    }

    // MARK: - Registered projects (new centralized layout)

    private func scanRegisteredProjects() -> [AgentSession] {
        let registryPath = "\(homeDir)/.aimux/projects.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: registryPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let projects = json["projects"] as? [[String: Any]] else {
            return []
        }

        var sessions: [AgentSession] = []
        var seenIds = Set<String>()

        for project in projects {
            guard let id = project["id"] as? String,
                  let name = project["name"] as? String,
                  let repoRoot = project["repoRoot"] as? String else { continue }

            let projectDir = "\(homeDir)/.aimux/projects/\(id)"

            // 1. Live sessions from instances.json (has instanceId for server detection)
            let instancesPath = "\(projectDir)/instances.json"
            if let instData = try? Data(contentsOf: URL(fileURLWithPath: instancesPath)),
               let instances = try? JSONSerialization.jsonObject(with: instData) as? [[String: Any]] {
                for inst in instances {
                    guard let pid = inst["pid"] as? Int, isProcessAlive(Int32(pid)),
                          let instSessions = inst["sessions"] as? [[String: Any]] else { continue }
                    let instanceId = inst["instanceId"] as? String ?? ""
                    let serverOwned = instanceId.hasPrefix("server-")

                    for s in instSessions {
                        let sid = s["id"] as? String ?? "unknown"
                        if seenIds.contains(sid) { continue }
                        seenIds.insert(sid)

                        sessions.append(AgentSession(
                            id: sid,
                            tool: s["tool"] as? String ?? "unknown",
                            label: nil,
                            headline: nil,
                            status: "running",
                            role: nil,
                            isServer: serverOwned,
                            projectName: name,
                            projectPath: repoRoot
                        ))
                    }
                }
            }

            // 2. Enrich live sessions with statusline.json (has role, status, active)
            let statuslinePath = "\(projectDir)/statusline.json"
            if let slData = try? Data(contentsOf: URL(fileURLWithPath: statuslinePath)),
               let sl = try? JSONSerialization.jsonObject(with: slData) as? [String: Any],
               let slSessions = sl["sessions"] as? [[String: Any]],
               isRecentlyActive(statuslinePath, maxAge: 10) {
                for s in slSessions {
                    let sid = s["id"] as? String ?? "unknown"
                    // Update existing session with richer info
                    if let idx = sessions.firstIndex(where: { $0.id == sid }) {
                        let existing = sessions[idx]
                        sessions[idx] = AgentSession(
                            id: sid,
                            tool: existing.tool,
                            label: s["label"] as? String ?? existing.label,
                            headline: s["headline"] as? String ?? existing.headline,
                            status: s["status"] as? String ?? existing.status,
                            role: s["role"] as? String,
                            isServer: existing.isServer,
                            projectName: name,
                            projectPath: repoRoot
                        )
                    } else if !seenIds.contains(sid) {
                        // Session in statusline but not in instances (shouldn't happen, but handle it)
                        seenIds.insert(sid)
                        sessions.append(AgentSession(
                            id: sid,
                            tool: s["tool"] as? String ?? "unknown",
                            label: s["label"] as? String,
                            headline: s["headline"] as? String,
                            status: s["status"] as? String ?? "idle",
                            role: s["role"] as? String,
                            isServer: false,
                            projectName: name,
                            projectPath: repoRoot
                        ))
                    }
                }
            }

            // 3. Offline sessions from state.json
            let statePath = "\(projectDir)/state.json"
            if let stateData = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
               let state = try? JSONSerialization.jsonObject(with: stateData) as? [String: Any],
               let stateSessions = state["sessions"] as? [[String: Any]] {
                for s in stateSessions {
                    let session = s["session"] as? [String: Any] ?? s
                    let sid = session["id"] as? String ?? "unknown"
                    if seenIds.contains(sid) { continue }
                    seenIds.insert(sid)

                    sessions.append(AgentSession(
                        id: sid,
                        tool: session["tool"] as? String ?? session["command"] as? String ?? "unknown",
                        label: session["label"] as? String,
                        headline: session["headline"] as? String,
                        status: "offline",
                        role: session["role"] as? String,
                        isServer: false,
                        projectName: name,
                        projectPath: repoRoot
                    ))
                }
            }
        }

        return sessions
    }

    private func isProcessAlive(_ pid: Int32) -> Bool {
        return kill(pid, 0) == 0
    }

    private func isServerRunning(pidPath: String) -> Bool {
        guard let content = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int32(content.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return false
        }
        return isProcessAlive(pid)
    }

    /// Check if a file was modified within maxAge seconds
    private func isRecentlyActive(_ path: String, maxAge: TimeInterval) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let modDate = attrs[.modificationDate] as? Date else { return false }
        return Date().timeIntervalSince(modDate) < maxAge
    }

    // MARK: - Legacy .aimux/ scanning

    private func scanLegacyAimux(excluding excludedPaths: Set<String>) -> [AgentSession] {
        var sessions: [AgentSession] = []
        var projectPaths = Set<String>()

        // Auto-discover in common dirs
        let scanDirs = ["\(homeDir)/cs", "\(homeDir)/projects", "\(homeDir)/dev", "\(homeDir)/src"]
        for scanDir in scanDirs {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: scanDir) else { continue }
            for entry in entries {
                let path = "\(scanDir)/\(entry)"
                if FileManager.default.fileExists(atPath: "\(path)/.aimux/state.json") {
                    projectPaths.insert(path)
                }
            }
        }

        // Remove projects already covered by registry
        projectPaths.subtract(excludedPaths)

        for projectPath in projectPaths {
            let projectName = URL(fileURLWithPath: projectPath).lastPathComponent
            let statePath = "\(projectPath)/.aimux/state.json"

            guard let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
                  let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let stateSessions = state["sessions"] as? [[String: Any]] else { continue }

            for s in stateSessions {
                let sid = s["id"] as? String ?? "unknown"
                let tool = s["command"] as? String ?? s["tool"] as? String ?? "unknown"

                sessions.append(AgentSession(
                    id: sid,
                    tool: tool,
                    label: s["label"] as? String,
                    headline: s["headline"] as? String,
                    status: "offline",
                    role: nil,
                    isServer: false,
                    projectName: projectName,
                    projectPath: projectPath
                ))
            }
        }

        return sessions
    }
}

// MARK: - Server Status

func runningProjectServerCount() -> Int {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let projectsDir = home.appendingPathComponent(".aimux/projects")
    guard let entries = try? FileManager.default.contentsOfDirectory(
        at: projectsDir,
        includingPropertiesForKeys: nil
    ) else {
        return 0
    }

    var count = 0
    for entry in entries {
        let pidURL = entry.appendingPathComponent("aimux.pid")
        guard let content = try? String(contentsOf: pidURL, encoding: .utf8),
              let pid = Int32(content.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            continue
        }
        if kill(pid, 0) == 0 {
            count += 1
        }
    }
    return count
}

// MARK: - Path Resolution

func findAimuxBinary() -> String {
    let fileManager = FileManager.default
    let home = fileManager.homeDirectoryForCurrentUser.path

    let directPaths = [
        "\(home)/.local/bin/aimux",
        "\(home)/bin/aimux",
        "/usr/local/bin/aimux",
        "/opt/homebrew/bin/aimux",
    ]
    for path in directPaths where fileManager.isExecutableFile(atPath: path) {
        return path
    }

    let nvmRoot = "\(home)/.nvm/versions/node"
    if let versions = try? fileManager.contentsOfDirectory(atPath: nvmRoot).sorted(by: >) {
        for version in versions {
            let candidate = "\(nvmRoot)/\(version)/bin/aimux"
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
    }

    let pathEntries = (ProcessInfo.processInfo.environment["PATH"] ?? "")
        .split(separator: ":")
        .map(String.init)
    for entry in pathEntries {
        let candidate = "\(entry)/aimux"
        if fileManager.isExecutableFile(atPath: candidate) {
            return candidate
        }
    }
    return "aimux"
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var scanner = ProjectScanner()
    private var timer: Timer?
    private var flashMessage: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.updateMenu()
        }
    }

    func updateMenu() {
        let allSessions = scanner.scan()
        let projects = scanner.scanProjects()
        // Only show sessions from active TUIs — hide stale/offline
        let sessions = allSessions.filter { $0.status != "offline" }
        let running = sessions.filter { $0.status == "running" || $0.status == "waiting" }
        let menu = NSMenu()

        if let flashMessage {
            let item = NSMenuItem(title: flashMessage, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            menu.addItem(NSMenuItem.separator())
        }

        // Icon
        if let button = statusItem.button {
            if !running.isEmpty {
                button.title = " \(running.count)"
                button.image = createDot(color: .systemGreen)
            } else if !sessions.isEmpty {
                button.title = ""
                button.image = createDot(color: .systemGray)
            } else {
                button.title = ""
                button.image = createDot(color: .systemGray)
            }
            button.image?.isTemplate = false
        }

        // Group by project
        let grouped = Dictionary(grouping: sessions) { $0.projectName }
        if projects.isEmpty && grouped.isEmpty {
            let item = NSMenuItem(title: "No projects", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            for project in projects.sorted(by: { $0.name < $1.name }) {
                let projectSessions = grouped[project.name] ?? []
                // Project header
                let headerTitle = project.serverRunning ? "\(project.name)  ●" : project.name
                let header = NSMenuItem(title: headerTitle, action: nil, keyEquivalent: "")
                header.isEnabled = false
                header.attributedTitle = NSAttributedString(
                    string: headerTitle,
                    attributes: [.font: NSFont.boldSystemFont(ofSize: 13)]
                )
                menu.addItem(header)

                let serverAction = NSMenuItem(
                    title: project.serverRunning ? "  Stop Project Server" : "  Start Project Server",
                    action: #selector(toggleProjectServer(_:)),
                    keyEquivalent: ""
                )
                serverAction.target = self
                serverAction.representedObject = ProjectActionTarget(project: project, shouldStart: !project.serverRunning)
                menu.addItem(serverAction)

                for session in projectSessions {
                    let icon: String
                    switch session.status {
                    case "running": icon = "\u{1F7E1}"   // yellow
                    case "waiting": icon = "\u{1F535}"   // blue
                    case "idle":    icon = "\u{1F7E2}"   // green
                    case "error":   icon = "\u{1F534}"   // red
                    default:        icon = "\u{26AA}"    // white/gray
                    }

                    let identity = session.label ?? session.tool
                    var parts = [identity]
                    if let role = session.role {
                        parts.append("(\(role))")
                    }
                    if session.isServer {
                        parts.append("[server]")
                    }
                    if let headline = session.headline, !headline.isEmpty {
                        parts.append("· \(headline)")
                    }
                    if session.status != "idle" && session.status != "offline" {
                        parts.append("— \(session.status)")
                    }

                    let title = "  \(icon) \(parts.joined(separator: " "))"
                    let item = NSMenuItem(title: title, action: #selector(openProject(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = session.projectPath
                    menu.addItem(item)
                }

                if projectSessions.isEmpty {
                    let empty = NSMenuItem(title: "  No active agents", action: nil, keyEquivalent: "")
                    empty.isEnabled = false
                    menu.addItem(empty)
                }

                menu.addItem(NSMenuItem.separator())
            }
        }

        // Project-scoped server status
        let serverCount = runningProjectServerCount()
        if serverCount > 0 {
            let serverLabel = serverCount == 1 ? "● 1 project server" : "● \(serverCount) project servers"
            let serverItem = NSMenuItem(title: serverLabel, action: nil, keyEquivalent: "")
            serverItem.isEnabled = false
            serverItem.attributedTitle = NSAttributedString(
                string: serverLabel,
                attributes: [.foregroundColor: NSColor.systemGreen, .font: NSFont.systemFont(ofSize: 13)]
            )
            menu.addItem(serverItem)
        } else {
            let serverItem = NSMenuItem(title: "○ No project servers", action: nil, keyEquivalent: "")
            serverItem.isEnabled = false
            menu.addItem(serverItem)
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

    @objc func openProject(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        let binary = findAimuxBinary()
        let script = """
        tell application "Terminal"
            activate
            do script "cd '\(path)' && \(binary)"
        end tell
        """
        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
        }
    }

    @objc func toggleProjectServer(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? ProjectActionTarget else { return }
        let binary = findAimuxBinary()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["server", action.shouldStart ? "start" : "stop"]
        process.currentDirectoryURL = URL(fileURLWithPath: action.project.repoRoot)
        process.environment = mergedEnvironment()

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
        } catch {
            setFlashMessage("\(action.shouldStart ? "Start" : "Stop") failed: \(error.localizedDescription)")
            return
        }

        process.terminationHandler = { [weak self] process in
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                if process.terminationStatus == 0 {
                    let verb = action.shouldStart ? "Started" : "Stopped"
                    self?.setFlashMessage("\(verb) server for \(action.project.name)")
                } else {
                    let fallback = action.shouldStart ? "Failed to start server" : "Failed to stop server"
                    self?.setFlashMessage(output?.isEmpty == false ? output! : fallback)
                }
                self?.updateMenu()
            }
        }
    }

    private func setFlashMessage(_ message: String) {
        flashMessage = message
        updateMenu()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            if self?.flashMessage == message {
                self?.flashMessage = nil
                self?.updateMenu()
            }
        }
    }

    private func mergedEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let rawEntries = [
            "\(home)/.local/bin",
            "\(home)/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            env["PATH"] ?? "",
        ].filter { !$0.isEmpty }
        var seen = Set<String>()
        let pathEntries = rawEntries
            .joined(separator: ":")
            .split(separator: ":")
            .map(String.init)
            .filter { entry in
                if seen.contains(entry) { return false }
                seen.insert(entry)
                return true
            }
        env["PATH"] = pathEntries.joined(separator: ":")
        return env
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
