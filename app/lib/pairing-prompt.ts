// A device waiting for approval cannot load anything, so the approval prompt is
// not a detail the user might want -- it is the only thing they can act on. It
// used to wait to be clicked, which left a thin banner in front of an app that
// looked simply broken.

export interface PairingPromptState {
  /// Whether the relay currently reports this device as waiting for approval.
  pending: boolean;
  /// Identifies the device waiting, so a second pending device prompts again.
  deviceId?: string;
  /// The device the prompt was last opened for, or null if it never has been.
  lastPromptedDeviceId: string | null;
}

export const PAIRING_PROMPT_UNIDENTIFIED_DEVICE = "pending-device";

export function pairingPromptDeviceKey(deviceId?: string): string {
  return deviceId && deviceId.trim() ? deviceId : PAIRING_PROMPT_UNIDENTIFIED_DEVICE;
}

// Open once per waiting device. Dismissing has to stick -- re-opening a modal
// the user just closed is the other way to make a prompt useless.
export function shouldOpenPairingPrompt(state: PairingPromptState): boolean {
  if (!state.pending) return false;
  return pairingPromptDeviceKey(state.deviceId) !== state.lastPromptedDeviceId;
}
