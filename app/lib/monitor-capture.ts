import type { MonitorAudioSampleRate, MonitorCaptureMode } from "@/stores/settings";

export const MONITOR_IMAGE_MIME_TYPE = "image/jpeg";
export const MONITOR_IMAGE_QUALITY = 0.38;
export const MONITOR_SPEECH_CONTEXT = [
  "aimux",
  "Claude",
  "Codex",
  "agent",
  "worktree",
  "debugging",
  "notes",
] as const;

export interface MonitorFrameSample {
  filename: string;
  mimeType: typeof MONITOR_IMAGE_MIME_TYPE;
  dataBase64: string;
  capturedAt: string;
  uri: string;
  width?: number;
  height?: number;
  sizeBytes: number;
}

export interface MonitorSampleTextInput {
  capturedAt: string;
  captureMode: MonitorCaptureMode;
  transcript?: string | null;
  frameAttached?: boolean;
  audioSampleRate?: MonitorAudioSampleRate;
}

export function monitorFrameFilename(capturedAt: Date | string = new Date()): string {
  const date = typeof capturedAt === "string" ? new Date(capturedAt) : capturedAt;
  const stamp = Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  return `monitor-${stamp.replace(/[:.]/g, "-")}.jpg`;
}

export function stripDataUrlBase64(value: string): string {
  const marker = ";base64,";
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

export function estimateBase64DecodedBytes(value: string): number {
  const base64 = stripDataUrlBase64(value).replace(/\s/g, "");
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function formatMonitorSampleText(input: MonitorSampleTextInput): string {
  const parts = [`Monitor sample captured at ${input.capturedAt}.`];
  if (input.frameAttached) parts.push("A camera frame is attached.");
  if (input.captureMode !== "camera" && input.audioSampleRate) {
    parts.push(`Audio sample rate: ${input.audioSampleRate} Hz.`);
  }
  const transcript = input.transcript?.trim();
  if (transcript) parts.push(`Speech transcript: ${transcript}`);
  return parts.join(" ");
}
