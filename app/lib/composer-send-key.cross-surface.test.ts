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
// `shouldSubmitComposerKey`, while iOS and Android each match the key against
// the device it came from, in Swift and Kotlin. On 2026-09-13 `7adb41638`
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

/// Code only. A commented-out call inside the body satisfied a plain
/// `toContain` just as happily as a live one.
function withoutComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/// One Kotlin declaration's code, so an assertion cannot be satisfied by the
/// prose above it -- `hasNoModifiers()` appears in both.
function kotlinRule(declaration: string): string {
  const start = KOTLIN_SOURCE.indexOf(declaration);
  expect(start, `Kotlin must still declare ${declaration}`).toBeGreaterThan(0);
  const ends = ["\n\n", "\n    }", "\n  }"].map((at) => KOTLIN_SOURCE.indexOf(at, start));
  const end = Math.min(...ends.filter((at) => at > start));
  expect(Number.isFinite(end)).toBe(true);
  return withoutComments(KOTLIN_SOURCE.slice(start, end));
}

const kotlinSendRule = () => kotlinRule("fun isSendKeyEvent(");
const kotlinIdentityRule = () => kotlinRule("private fun isHardwareKeyboardEvent(");

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
    const rule = kotlinSendRule();
    expect(rule).toContain("event.hasNoModifiers()");
    // And names no individual modifier, because naming one is how it drifts.
    for (const named of ["META_SHIFT", "META_ALT", "META_CTRL", "isShiftPressed"]) {
      expect(KOTLIN_SOURCE).not.toContain(named);
    }
    for (const modifier of MODIFIERS) {
      expect(
        shouldSubmitComposerKey({ key: "Enter", [modifier.web]: true }, true),
        `web must not send on ${modifier.web}+Enter`,
      ).toBe(false);
    }
  });

  it("asks and answers with the same idea of a keyboard on Android", () => {
    // `KEYBOARD_12KEY` would pass a `!= KEYBOARD_NOKEYS` query while failing
    // the event's `KEYBOARD_TYPE_ALPHABETIC`, so JS would call it a hardware
    // keyboard and Enter would never send.
    const query = kotlinRule("fun isHardwareKeyboardConnected(");
    expect(query).toContain("Configuration.KEYBOARD_QWERTY");
    expect(query).toContain("Configuration.HARDKEYBOARDHIDDEN_NO");
    expect(KOTLIN_SOURCE).not.toContain("KEYBOARD_NOKEYS");
  });

  it("forgets the focused composer when the JS context is replaced", () => {
    // The flag is process-scoped and only JS writes it, so a JS fatal or an
    // OTA reload leaves it set with no cleanup having run. `dispatchKeyEvent`
    // would then consume every Enter app-wide and deliver it nowhere.
    expect(kotlinRule("init {")).toContain("isChatComposerFocused = false");
  });

  it("needs a real key on Android, because only the event knows", () => {
    // An IME injects as `VIRTUAL_KEYBOARD` (-1) and the built-in keypad is 0,
    // so this is the gate a soft keyboard cannot pass -- Android's equivalent
    // of iOS only ever seeing a `UIKey`.
    const identity = kotlinIdentityRule();
    // `isVirtual` is `id < 0`, which every injected event carries.
    expect(identity).toContain("!device.isVirtual");
    expect(identity).toContain("InputDevice.KEYBOARD_TYPE_ALPHABETIC");
    expect(identity).toContain("InputDevice.SOURCE_KEYBOARD");
    // Android repeats a held key as more ACTION_DOWNs where iOS fires once, so
    // without this one held Enter sends a message per repeat.
    const rule = kotlinSendRule();
    expect(rule).toContain("event.repeatCount == 0");
    // Without this the UP matches too and one press sends twice -- the same
    // failure `repeatCount` guards, from the other direction.
    expect(rule).toContain("event.action == KeyEvent.ACTION_DOWN");
    const returnKeys = kotlinRule("private fun isReturnKeyCode(");
    expect(returnKeys).toContain("KeyEvent.KEYCODE_ENTER");
    expect(returnKeys).toContain("KeyEvent.KEYCODE_NUMPAD_ENTER");
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
    // `isNativeAppCommand` is an allowlist, so a command either native side
    // emits that is missing from it is dropped in silence -- the
    // keyboard-connect notice would never arrive and the answer would stay
    // stale.
    // Each arm separately: a combined count is satisfied by the other one, so
    // renaming the Kotlin constants would have contributed zero in silence.
    const perSurface = {
      ios: [...SWIFT_SOURCE.matchAll(/emit\("([a-zA-Z]+)"\)/g)].map((m) => m[1]),
      android: [...KOTLIN_SOURCE.matchAll(/val COMMAND_[A-Z_]+ = "([a-zA-Z]+)"/g)].map((m) => m[1]),
    };
    for (const [surface, commands] of Object.entries(perSurface)) {
      expect(commands.length, `${surface} must emit at least one command`).toBeGreaterThan(0);
      for (const command of commands) {
        expect(NATIVE_APP_COMMANDS as readonly string[], surface).toContain(command);
      }
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
    // and the send rule came to disagree on Android, back when nothing there
    // answered and the one-shot returned false forever.
    expect(SCREEN_SOURCE).not.toContain("getNativeHardwareKeyboardConnected");
    expect(SCREEN_SOURCE).toContain("useHasHardwareKeyboard()");
  });
});
