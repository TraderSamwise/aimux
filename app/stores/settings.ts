import { atomWithStorage, unwrap } from "jotai/utils";
import { focusAtom } from "jotai-optics";
import { createSsrSafeMergingJsonStorage } from "@/lib/jotai-storage";

export type ThemePreference = "system" | "light" | "dark";

export const defaultSettings = Object.freeze({
  theme: "dark" as ThemePreference,
  chatTerminalSplit: false as boolean,
});

export type AppSettings = typeof defaultSettings;

const asyncSettingsAtom = atomWithStorage<AppSettings>(
  "aimux-settings",
  defaultSettings,
  createSsrSafeMergingJsonStorage(defaultSettings),
  { getOnInit: true },
);

export const settingsAtom = unwrap(asyncSettingsAtom, (previous) => previous ?? defaultSettings);

export const themePreferenceAtom = focusAtom(settingsAtom, (optic) => optic.prop("theme"));
export const chatTerminalSplitAtom = focusAtom(settingsAtom, (optic) =>
  optic.prop("chatTerminalSplit"),
);
