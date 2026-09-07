import React
import GameController
import UIKit

@objc(AimuxNativeCommands)
class AimuxNativeCommands: RCTEventEmitter {
  private static weak var sharedEmitter: AimuxNativeCommands?
  private static var chatComposerFocused = false
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

  static func setChatComposerFocused(_ focused: Bool) {
    chatComposerFocused = focused
  }

  static var isChatComposerFocused: Bool {
    chatComposerFocused
  }

  static func hardwareKeyboardConnected() -> Bool {
    if #available(iOS 14.0, *) {
      if ProcessInfo.processInfo.isiOSAppOnMac {
        return true
      }
      return GCKeyboard.coalesced != nil
    }
    return false
  }

  @objc func setChatComposerFocused(_ focused: Bool) {
    AimuxNativeCommands.setChatComposerFocused(focused)
  }

  @objc func getHardwareKeyboardConnected(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    resolve(AimuxNativeCommands.hardwareKeyboardConnected())
  }

  private func emit(_ command: String) {
    guard isObserving else { return }
    sendEvent(withName: "AimuxNativeCommand", body: ["command": command])
  }
}

class AimuxWindow: UIWindow {
  override func sendEvent(_ event: UIEvent) {
    if let pressesEvent = event as? UIPressesEvent,
       let command = command(for: pressesEvent) {
      AimuxNativeCommands.emit(command)
      return
    }
    super.sendEvent(event)
  }

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
      command(input: UIKeyCommand.inputEscape, modifiers: [], action: #selector(chatInterrupt)),
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

  @objc private func chatInterrupt() {
    AimuxNativeCommands.emit("chatInterrupt")
  }

  private func command(for event: UIPressesEvent) -> String? {
    for press in event.allPresses where press.phase == .began {
      guard let key = press.key else { continue }
      if isEscapeKey(key) {
        return "chatInterrupt"
      }
      if AimuxNativeCommands.isChatComposerFocused && isPlainReturnKey(key) {
        return "chatSend"
      }
    }
    return nil
  }

  private func isPlainReturnKey(_ key: UIKey) -> Bool {
    let disallowedModifiers: UIKeyModifierFlags = [.shift, .command, .alternate, .control]
    return isReturnKey(key) && key.modifierFlags.intersection(disallowedModifiers).isEmpty
  }

  private func isReturnKey(_ key: UIKey) -> Bool {
    key.keyCode == .keyboardReturnOrEnter ||
      key.keyCode == .keyboardReturn ||
      key.charactersIgnoringModifiers == "\r" ||
      key.charactersIgnoringModifiers == "\n"
  }

  private func isEscapeKey(_ key: UIKey) -> Bool {
    key.keyCode == .keyboardEscape || key.charactersIgnoringModifiers == UIKeyCommand.inputEscape
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

  @objc func aimuxChatInterrupt(_ sender: UICommand) {
    AimuxNativeCommands.emit("chatInterrupt")
  }
}
