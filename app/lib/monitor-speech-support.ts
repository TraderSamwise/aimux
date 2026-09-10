import { getErrorMessage } from "@/lib/request-errors";

export type OnDeviceLocaleSupport =
  | { status: "supported" }
  | { status: "unsupported"; message: string }
  | { status: "unknown"; message: string };

export interface OnDeviceLocaleSupportDeps {
  platformOS: string;
  supportsOnDeviceRecognition: () => boolean;
  getSupportedLocales: () => Promise<{ installedLocales: string[] }>;
}

export async function resolveOnDeviceLocaleSupport(
  locale: string,
  deps: OnDeviceLocaleSupportDeps,
): Promise<OnDeviceLocaleSupport> {
  if (!deps.supportsOnDeviceRecognition()) {
    return unsupported(locale);
  }
  if (deps.platformOS === "ios") {
    return { status: "supported" };
  }
  try {
    const supported = await deps.getSupportedLocales();
    return supported.installedLocales.includes(locale)
      ? { status: "supported" }
      : unsupported(locale);
  } catch (err) {
    return {
      status: "unknown",
      message: `Could not check on-device speech support for ${locale}: ${getErrorMessage(err)}`,
    };
  }
}

function unsupported(locale: string): OnDeviceLocaleSupport {
  return {
    status: "unsupported",
    message: `On-device speech is unavailable for ${locale}.`,
  };
}
