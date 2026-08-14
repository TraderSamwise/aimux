import { describe, expect, it } from "vitest";
import {
  estimateBase64DecodedBytes,
  formatMonitorSampleText,
  monitorFrameFilename,
  stripDataUrlBase64,
} from "./monitor-capture";

describe("monitor capture helpers", () => {
  it("builds stable jpeg filenames from capture timestamps", () => {
    expect(monitorFrameFilename("2026-08-14T01:02:03.456Z")).toBe(
      "monitor-2026-08-14T01-02-03-456Z.jpg",
    );
  });

  it("strips data-url prefixes before estimating decoded size", () => {
    const raw = "aGVsbG8=";

    expect(stripDataUrlBase64(`data:image/jpeg;base64,${raw}`)).toBe(raw);
    expect(estimateBase64DecodedBytes(raw)).toBe(5);
    expect(estimateBase64DecodedBytes(`data:image/jpeg;base64,${raw}`)).toBe(5);
  });

  it("formats monitor samples with frame, transcript, and sample-rate context", () => {
    expect(
      formatMonitorSampleText({
        capturedAt: "2026-08-14T01:02:03.456Z",
        captureMode: "camera-audio",
        frameAttached: true,
        transcript: "ship the notes",
        audioSampleRate: 16000,
      }),
    ).toBe(
      "Monitor sample captured at 2026-08-14T01:02:03.456Z. A camera frame is attached. Audio sample rate: 16000 Hz. Speech transcript: ship the notes",
    );
  });
});
