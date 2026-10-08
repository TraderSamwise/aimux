import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The command allowlist is a plain array, but it lives beside the bridge, and
// react-native itself will not parse here. Same shape as
// `native-app-commands.test.ts`.
vi.mock("react-native", () => ({
  NativeEventEmitter: class {},
  NativeModules: {},
  Platform: { OS: "web" },
}));

import { shouldSubmitComposerKey } from "@/lib/composer-protocol";
import { NATIVE_APP_COMMANDS } from "@/lib/native-app-commands";

// AGENTS.md "One Answer, Many Surfaces". Three surfaces decide whether Enter
// sends, and only one of them is reachable from a unit test: web calls
// `shouldSubmitComposerKey`, iOS matches modifier flags in Swift, Android hands
// the decision to the platform's editor action. On 2026-09-13 `7adb41638`
// changed the TS rule, the Swift modifier set AND the assertion that guarded
// them, in one commit, and Shift+Enter became a second send key on every
// surface at once. A per-surface test could not have caught that; this compares
// them to each other.

const SWIFT_SOURCE = readFileSync(
  join(__dirname, "..", "plugins", "ios", "AimuxNativeCommands.swift"),
  "utf8",
);
/// `output: "single"` builds `index.html` from this template, which is the only
/// place a viewport declaration is honoured: `+html.tsx` is for
/// `output: "static"` and is ignored here, silently.
const HTML_TEMPLATE = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");
const KOTLIN_SOURCE = readFileSync(
  join(__dirname, "..", "plugins", "android", "AimuxNativeCommandsModule.kt"),
  "utf8",
);
const SCREEN_SOURCE = readFileSync(
  join(__dirname, "..", "components", "screens", "AgentChatScreen.tsx"),
  "utf8",
);

/// Each modifier, in the spelling the web event uses and the spelling iOS uses
/// for the same physical key.
const MODIFIERS = [
  { swift: ".shift", web: "shiftKey" as const },
  { swift: ".command", web: "metaKey" as const },
  { swift: ".alternate", web: "altKey" as const },
  { swift: ".control", web: "ctrlKey" as const },
];

function iosDisallowedModifiers(): string {
  const match = SWIFT_SOURCE.match(/let disallowedModifiers: UIKeyModifierFlags = \[([^\]]*)\]/);
  expect(match, "iOS must still refuse a return key by a list of modifiers").toBeTruthy();
  return match![1];
}

describe("composer send key, across surfaces", () => {
  it("refuses the same modified Enter on web and on iOS", () => {
    const disallowed = iosDisallowedModifiers();
    for (const modifier of MODIFIERS) {
      expect(
        shouldSubmitComposerKey({ key: "Enter", [modifier.web]: true }, true),
        `web must not send on ${modifier.web}+Enter`,
      ).toBe(false);
      expect(
        disallowed.includes(modifier.swift),
        `iOS must not send on ${modifier.swift}+Enter, so ${modifier.swift} belongs in disallowedModifiers`,
      ).toBe(true);
    }
  });

  it("sends an unmodified Enter on web and on iOS", () => {
    expect(shouldSubmitComposerKey({ key: "Enter" }, true)).toBe(true);
    // A denylist, so a flag nobody listed -- caps lock, the numeric pad -- is
    // not silently turned into a refusal to send.
    expect(SWIFT_SOURCE).toContain("key.modifierFlags.intersection(disallowedModifiers).isEmpty");
  });

  it("needs no keyboard detection on iOS, because only a real key arrives", () => {
    // `pressesBegan`/`sendEvent` see `UIPressesEvent` only from a hardware
    // keyboard; a soft return reaches the text view as text instead. That is
    // why the iOS half carries no hardware check and must not grow one.
    expect(SWIFT_SOURCE).toContain("if let pressesEvent = event as? UIPressesEvent,");
    expect(SWIFT_SOURCE).toContain("isSendReturnKey(key)");
  });

  it("gates the web rule on the hardware answer, never on a literal", () => {
    expect(SCREEN_SOURCE).toContain("shouldSubmitComposerKey(keyEvent, hasHardwareKeyboard)");
  });

  it("hands Android's Enter to no editor action", () => {
    // Android sends from `dispatchKeyEvent`, which sees the device the key came
    // from. `submitBehavior: "submit"` would instead hand the editor action
    // every Enter, including a soft keyboard's, which is what eats a line break.
    //
    // Scoped to the composer's own props rather than the whole file, so an
    // unrelated input gaining a legitimate `onSubmitEditing` does not fail it.
    const start = SCREEN_SOURCE.indexOf("const composerKeyboardProps");
    expect(start).toBeGreaterThan(0);
    const props = SCREEN_SOURCE.slice(start, SCREEN_SOURCE.indexOf("\n  );", start));
    expect(props).not.toContain("submitBehavior");
    expect(props).not.toContain("onSubmitEditing");
    expect(props).not.toContain("returnKeyType");
  });

  it("refuses the same modified Enter on Android as on web", () => {
    // Kotlin does not spell the modifiers out: `hasNoModifiers()` is the very
    // predicate AOSP's `TextView.doKeyDown` gates the editor action on, so the
    // platform and this rule cannot drift. A hand-rolled shift check could.
    expect(KOTLIN_SOURCE).toContain("event.hasNoModifiers()");
    expect(KOTLIN_SOURCE).not.toContain("META_SHIFT");
    expect(KOTLIN_SOURCE).not.toContain("isShiftPressed");
    for (const modifier of MODIFIERS) {
      expect(
        shouldSubmitComposerKey({ key: "Enter", [modifier.web]: true }, true),
        `web must not send on ${modifier.web}+Enter`,
      ).toBe(false);
    }
  });

  it("needs a real key on Android, because only the event knows", () => {
    // An IME injects as `VIRTUAL_KEYBOARD` (-1) and the built-in keypad is 0,
    // so this is the gate a soft keyboard cannot pass -- Android's equivalent
    // of iOS only ever seeing a `UIKey`.
    expect(KOTLIN_SOURCE).toContain("event.deviceId > 0");
    expect(KOTLIN_SOURCE).toContain("InputDevice.KEYBOARD_TYPE_ALPHABETIC");
    expect(KOTLIN_SOURCE).toContain("InputDevice.SOURCE_KEYBOARD");
  });

  it("declares the viewport the web measurement depends on", () => {
    // Which viewport a browser shrinks for a soft keyboard has been the UA's
    // choice. The measurement reads the gap between the two, so a browser that
    // shrinks both leaves none and Enter would send on glass.
    // Read the meta tag's own content, not the file: the first version of this
    // passed on the phrase appearing in the comment explaining it.
    const meta = HTML_TEMPLATE.match(/name="viewport"\s*content="([^"]*)"/);
    expect(meta, "the template must carry one viewport meta").toBeTruthy();
    expect(meta![1]).toContain("interactive-widget=resizes-visual");
    // The placeholders Expo substitutes, so the template cannot drift into one
    // that drops the title or the language.
    expect(HTML_TEMPLATE).toContain("%WEB_TITLE%");
    expect(HTML_TEMPLATE).toContain("%LANG_ISO_CODE%");
  });

  it("delivers every command the native side emits", () => {
    // `isNativeAppCommand` is an allowlist, so a command iOS emits that is
    // missing from it is dropped in silence -- the keyboard-connect notice
    // would simply never arrive and the answer would stay stale.
    const emitted = [
      ...SWIFT_SOURCE.matchAll(/emit\("([a-zA-Z]+)"\)/g),
      ...KOTLIN_SOURCE.matchAll(/val COMMAND_[A-Z_]+ = "([a-zA-Z]+)"/g),
    ].map((match) => match[1]);
    expect(emitted.length).toBeGreaterThan(0);
    for (const command of emitted) {
      expect(NATIVE_APP_COMMANDS as readonly string[]).toContain(command);
    }
  });

  it("is told when a keyboard is attached rather than polling for it", () => {
    // A keyboard attached after launch moves no keyboard frame and raises no
    // keyboard event, so re-querying off one left the answer stale.
    expect(SWIFT_SOURCE).toContain("GCKeyboardDidConnect");
    expect(SWIFT_SOURCE).toContain('AimuxNativeCommands.emit("hardwareKeyboardChanged")');
    expect(readFileSync(join(__dirname, "hardware-keyboard.ts"), "utf8")).toContain(
      'command === "hardwareKeyboardChanged"',
    );
  });

  it("asks one source for the hardware answer", () => {
    // Two callers asking the native bridge separately is how the auto-focus
    // and the send rule came to disagree on Android, where no such module
    // exists and the one-shot answered false forever.
    expect(SCREEN_SOURCE).not.toContain("getNativeHardwareKeyboardConnected");
    expect(SCREEN_SOURCE).toContain("useHasHardwareKeyboard()");
  });
});
