import React
import UIKit

@objc(AimuxNativeCommands)
class AimuxNativeCommands: RCTEventEmitter {
  private static weak var sharedEmitter: AimuxNativeCommands?
  private var isObserving = false

  override init() {
    super.init()
    AimuxNativeCommands.sharedEmitter = self
  }

  override static func requiresMainQueueSetup() -> Bool {
    true
  }

  override func supportedEvents() -> [String]! {
    ["AimuxNativeCommand"]
  }

  override func startObserving() {
    isObserving = true
  }

  override func stopObserving() {
    isObserving = false
  }

  static func emit(_ command: String) {
    DispatchQueue.main.async {
      sharedEmitter?.emit(command)
    }
  }

  private func emit(_ command: String) {
    guard isObserving else { return }
    sendEvent(withName: "AimuxNativeCommand", body: ["command": command])
  }
}

class AimuxWindow: UIWindow {
  override var keyCommands: [UIKeyCommand]? {
    [
      command(input: "+", modifiers: [.command], action: #selector(zoomIn)),
      command(input: "=", modifiers: [.command], action: #selector(zoomIn)),
      command(input: "-", modifiers: [.command], action: #selector(zoomOut)),
      command(input: "0", modifiers: [.command], action: #selector(zoomReset)),
      command(input: "+", modifiers: [.control], action: #selector(zoomIn)),
      command(input: "=", modifiers: [.control], action: #selector(zoomIn)),
      command(input: "-", modifiers: [.control], action: #selector(zoomOut)),
      command(input: "0", modifiers: [.control], action: #selector(zoomReset)),
    ]
  }

  private func command(
    input: String,
    modifiers: UIKeyModifierFlags,
    action: Selector
  ) -> UIKeyCommand {
    UIKeyCommand(input: input, modifierFlags: modifiers, action: action)
  }

  @objc private func zoomIn() {
    AimuxNativeCommands.emit("desktopZoomIn")
  }

  @objc private func zoomOut() {
    AimuxNativeCommands.emit("desktopZoomOut")
  }

  @objc private func zoomReset() {
    AimuxNativeCommands.emit("desktopZoomReset")
  }
}

extension UIApplication {
  @objc func aimuxDesktopZoomIn(_ sender: UICommand) {
    AimuxNativeCommands.emit("desktopZoomIn")
  }

  @objc func aimuxDesktopZoomOut(_ sender: UICommand) {
    AimuxNativeCommands.emit("desktopZoomOut")
  }

  @objc func aimuxDesktopZoomReset(_ sender: UICommand) {
    AimuxNativeCommands.emit("desktopZoomReset")
  }
}
