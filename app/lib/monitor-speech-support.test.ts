import { describe, expect, it } from "vitest";
import { resolveOnDeviceLocaleSupport } from "./monitor-speech-support";

describe("resolveOnDeviceLocaleSupport", () => {
  it("reports a genuinely unsupported locale as unavailable", async () => {
    const result = await resolveOnDeviceLocaleSupport("fr-FR", {
      platformOS: "android",
      supportsOnDeviceRecognition: () => true,
      getSupportedLocales: async () => ({ installedLocales: ["en-US"] }),
    });

    expect(result).toEqual({
      status: "unsupported",
      message: "On-device speech is unavailable for fr-FR.",
    });
  });

  it("does not report a failed locale query as an unsupported language", async () => {
    const result = await resolveOnDeviceLocaleSupport("fr-FR", {
      platformOS: "android",
      supportsOnDeviceRecognition: () => true,
      getSupportedLocales: async () => {
        throw new Error("locale service unavailable");
      },
    });

    expect(result.status).toBe("unknown");
    if (result.status !== "unknown") throw new Error("expected unknown locale support status");
    expect(result.message).toBe(
      "Could not check on-device speech support for fr-FR: locale service unavailable",
    );
    expect(result.message).not.toBe("On-device speech is unavailable for fr-FR.");
  });

  it("accepts installed locales on platforms that require an installed-locale query", async () => {
    const result = await resolveOnDeviceLocaleSupport("en-US", {
      platformOS: "android",
      supportsOnDeviceRecognition: () => true,
      getSupportedLocales: async () => ({ installedLocales: ["en-US"] }),
    });

    expect(result).toEqual({ status: "supported" });
  });
});
