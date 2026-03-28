import AppKit
import Foundation

// MARK: - Data Models

struct AgentSession {
    let id: String
    let tool: String
    let name: String
    let status: String       // "idle", "running", "waiting", "error", "offline"
    let role: String?        // "coder", "reviewer", etc.
    let projectName: String
    let projectPath: String
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

    // MARK: - Registered projects (new centralized layout)

    private func scanRegisteredProjects() -> [AgentSession] {
        let registryPath = "\(homeDir)/.aimux/projects.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: registryPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let projects = json["projects"] as? [[String: Any]] else {
            return []
        }

        var sessions: [AgentSession] = []

        for project in projects {
            guard let id = project["id"] as? String,
                  let name = project["name"] as? String,
                  let repoRoot = project["repoRoot"] as? String else { continue }

            // Try statusline.json first (freshest, written every ~1s by multiplexer)
            let statuslinePath = "\(homeDir)/.aimux/projects/\(id)/statusline.json"
            if let slData = try? Data(contentsOf: URL(fileURLWithPath: statuslinePath)),
               let sl = try? JSONSerialization.jsonObject(with: slData) as? [String: Any],
               let slSessions = sl["sessions"] as? [[String: Any]],
               isRecentlyActive(statuslinePath, maxAge: 10) {
                for s in slSessions {
                    let sid = s["id"] as? String ?? "unknown"
                    let tool = s["tool"] as? String ?? "unknown"
                    let status = s["status"] as? String ?? "idle"
                    let role = s["role"] as? String
                    let active = s["active"] as? Bool ?? false

                    sessions.append(AgentSession(
                        id: sid,
                        tool: tool,
                        name: active ? "\(tool)*" : tool,
                        status: status,
                        role: role,
                        projectName: name,
                        projectPath: repoRoot
                    ))
                }
                continue
            }

            // Fall back to state.json (persisted on exit)
            let statePath = "\(homeDir)/.aimux/projects/\(id)/state.json"
            guard let stateData = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
                  let state = try? JSONSerialization.jsonObject(with: stateData) as? [String: Any],
                  let stateSessions = state["sessions"] as? [[String: Any]] else { continue }

            let isActive = isRecentlyActive(statePath, maxAge: 120)

            for s in stateSessions {
                // state.json may have sessions at top level or nested under "session"
                let session = s["session"] as? [String: Any] ?? s
                let sid = session["id"] as? String ?? "unknown"
                let tool = session["tool"] as? String ?? session["command"] as? String ?? "unknown"
                let rawStatus = session["status"] as? String ?? "idle"
                let role = session["role"] as? String

                let status = isActive ? rawStatus : "offline"

                sessions.append(AgentSession(
                    id: sid,
                    tool: tool,
                    name: tool,
                    status: status,
                    role: role,
                    projectName: name,
                    projectPath: repoRoot
                ))
            }
        }

        return sessions
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
                    name: tool,
                    status: "offline",
                    role: nil,
                    projectName: projectName,
                    projectPath: projectPath
                ))
            }
        }

        return sessions
    }
}

// MARK: - Path Resolution

func findAimuxBinary() -> String {
    // Check common locations
    let paths = [
        "\(FileManager.default.homeDirectoryForCurrentUser.path)/.nvm/versions/node/v22.13.0/bin/aimux",
        "/usr/local/bin/aimux",
        "/opt/homebrew/bin/aimux",
    ]
    for p in paths {
        if FileManager.default.fileExists(atPath: p) { return p }
    }
    return "aimux"
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var scanner = ProjectScanner()
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateMenu()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.updateMenu()
        }
    }

    func updateMenu() {
        let allSessions = scanner.scan()
        // Only show sessions from active TUIs — hide stale/offline
        let sessions = allSessions.filter { $0.status != "offline" }
        let running = sessions.filter { $0.status == "running" || $0.status == "waiting" }
        let menu = NSMenu()

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
                    case "running": icon = "\u{1F7E1}"   // yellow
                    case "waiting": icon = "\u{1F535}"   // blue
                    case "idle":    icon = "\u{1F7E2}"   // green
                    case "error":   icon = "\u{1F534}"   // red
                    default:        icon = "\u{26AA}"    // white/gray
                    }

                    var parts = [session.name]
                    if let role = session.role {
                        parts.append("(\(role))")
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
