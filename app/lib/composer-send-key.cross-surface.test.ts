import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// The command allowlist is a plain array, but it lives beside the bridge, and
// react-native itself will not parse here. Same shape as
// `native-app-commands.test.ts`.
vi.mock("react-native", () => ({
  NativeEventEmitter: class {},
  NativeModules: {},
  Platform: { OS: "web" },
}));

import { shouldSubmitComposerKey, type ComposerKeyEventLike } from "@/lib/composer-protocol";
import { NATIVE_APP_COMMANDS } from "@/lib/native-app-commands";

// AGENTS.md "One Answer, Many Surfaces": compare web, iOS, Android and screen.
// On 2026-09-13 `7adb41638` changed TS, Swift and its assertion together,
// accidentally allowing Shift+Enter. Keep an independent newline invariant.

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
  const match = withoutComments(SWIFT_SOURCE).match(
    /let disallowedModifiers: UIKeyModifierFlags = \[([^\]]*)\]/,
  );
  expect(match, "iOS must still refuse a return key by a list of modifiers").toBeTruthy();
  return match![1];
}

type ScreenKeyEvent = ComposerKeyEventLike & {
  nativeEvent?: ComposerKeyEventLike;
  preventDefault?: () => void;
};

// Execute the screen's callback and keyboard-props wiring without its stores.
const screenStart = SCREEN_SOURCE.indexOf("const handleComposerKeyboardEvent = useCallback(");
const screenEnd = SCREEN_SOURCE.indexOf("const handleComposerDraftChange", screenStart);
const propsStart = SCREEN_SOURCE.indexOf("const composerKeyboardProps = useMemo(");
const propsEnd = SCREEN_SOURCE.indexOf("\n  );", propsStart) + "\n  );".length;
expect(screenStart).toBeGreaterThan(0);
expect(screenEnd).toBeGreaterThan(screenStart);
expect(propsStart).toBeGreaterThan(0);
expect(propsEnd).toBeGreaterThan(propsStart);
const screenCallback = ts.transpileModule(
  SCREEN_SOURCE.slice(screenStart, screenEnd) + SCREEN_SOURCE.slice(propsStart, propsEnd),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  },
).outputText;

function screenKeyboardHandler(hasHardwareKeyboard: boolean) {
  const send = vi.fn();
  const handler = new Function(
    "Platform",
    "useCallback",
    "useMemo",
    "shouldSubmitComposerKey",
    "hasHardwareKeyboard",
    "canUseOwnerControls",
    "handleInterrupt",
    "handleSendMessage",
    `${screenCallback}\nreturn composerKeyboardProps.onKeyDown;`,
  )(
    { OS: "web" },
    (callback: unknown) => callback,
    (factory: () => unknown) => factory(),
    shouldSubmitComposerKey,
    hasHardwareKeyboard,
    true,
    vi.fn(),
    send,
  ) as (event: ScreenKeyEvent) => void;
  return { handler, send };
}

describe("composer send key, across surfaces", () => {
  it("agrees on Enter and Ctrl+Enter while every Shift/Alt/Meta combination stays a newline", () => {
    const disallowed = iosDisallowedModifiers();
    const kotlin = kotlinSendRule().replace(/\s+/g, " ");
    expect(kotlin).toBe(
      "fun isSendKeyEvent(event: KeyEvent): Boolean = event.action == KeyEvent.ACTION_DOWN && " +
        "event.repeatCount == 0 && isReturnKeyCode(event.keyCode) && " +
        "(event.hasNoModifiers() || event.hasModifiers(KeyEvent.META_CTRL_ON)) && isHardwareKeyboardEvent(event)",
    );
    const swift = withoutComments(SWIFT_SOURCE).match(
      /private func isSendReturnKey\(_ key: UIKey\) -> Bool \{([^}]+)\}/,
    );
    expect(swift, "iOS must expose the scoped send predicate").toBeTruthy();
    expect(swift![1].trim().replace(/\s+/g, " ")).toBe(
      "let disallowedModifiers: UIKeyModifierFlags = [.shift, .command, .alternate] " +
        "return isReturnKey(key) && key.modifierFlags.intersection(disallowedModifiers).isEmpty",
    );
    for (const modifier of MODIFIERS) {
      expect(disallowed.includes(modifier.swift), modifier.swift).toBe(modifier.web !== "ctrlKey");
    }
    for (let mask = 0; mask < 16; mask++) {
      const event: ComposerKeyEventLike = { key: "Enter", code: "Enter" };
      MODIFIERS.forEach((modifier, index) => {
        event[modifier.web] = Boolean(mask & (1 << index));
      });
      const expected = !event.shiftKey && !event.altKey && !event.metaKey;
      const iosSends = !MODIFIERS.some(
        (modifier) => event[modifier.web] && disallowed.includes(modifier.swift),
      );
      expect(iosSends, `iOS modifiers ${mask}`).toBe(expected);
      expect(shouldSubmitComposerKey(event, true), `web modifiers ${mask}`).toBe(iosSends);
      expect(shouldSubmitComposerKey(event, false), `undetected keyboard modifiers ${mask}`).toBe(
        expected && event.ctrlKey,
      );
      for (const hardware of [false, true]) {
        for (const nested of [false, true]) {
          const { handler, send } = screenKeyboardHandler(hardware);
          const preventDefault = vi.fn();
          handler({ ...(nested ? { nativeEvent: event } : event), preventDefault });
          const sends = shouldSubmitComposerKey(event, hardware);
          expect(
            send.mock.calls.length,
            `screen modifiers ${mask}, hardware ${hardware}, nativeEvent ${nested}`,
          ).toBe(Number(sends));
          expect(preventDefault.mock.calls.length).toBe(Number(sends));
          if (sends) expect(send).toHaveBeenCalledWith({ preserveFocus: true });
        }
      }
    }
  });

  it("needs no keyboard detection on iOS, because only a real key arrives", () => {
    // `pressesBegan`/`sendEvent` see `UIPressesEvent` only from a hardware
    // keyboard; a soft return reaches the text view as text instead. That is
    // why the iOS half carries no hardware check and must not grow one.
    expect(SWIFT_SOURCE).toContain("if let pressesEvent = event as? UIPressesEvent,");
    expect(SWIFT_SOURCE).toContain("isSendReturnKey(key)");
  });

  it("preserves physical key identity and nativeEvent precedence through the screen", () => {
    for (const code of [undefined, "Enter", "NumpadEnter", ""]) {
      const event = { key: "Enter", code, ctrlKey: true };
      const { handler, send } = screenKeyboardHandler(false);
      handler({ nativeEvent: event });
      expect(send.mock.calls.length).toBe(Number(shouldSubmitComposerKey(event, false)));
    }
    const { handler, send } = screenKeyboardHandler(false);
    handler({ key: "Enter", ctrlKey: true, nativeEvent: { key: "Enter", ctrlKey: false } });
    handler({ key: "a", ctrlKey: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("attaches the shared keyboard props to the rendered composer input", () => {
    const screen = withoutComments(SCREEN_SOURCE);
    expect(screen).toMatch(
      /<ComposerDraftTextInput\b[^]*?composerKeyboardProps=\{composerKeyboardProps\}/,
    );
    const input = screen.slice(screen.indexOf("const ComposerDraftTextInput ="));
    expect(input).toMatch(/<TextInput\b[^]*?\{\.\.\.composerKeyboardProps\}/);
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

  it("maps Escape to an interrupt on both native surfaces", () => {
    // iOS answers `chatInterrupt` for Escape before the focus check, and it is
    // also a window key command and an Edit-menu item -- an app-level
    // accelerator. Android mirrors that rather than inventing a focus gate.
    expect(SWIFT_SOURCE).toContain('return "chatInterrupt"');
    const interrupt = kotlinRule("fun isInterruptKeyEvent(");
    expect(interrupt).toContain("KeyEvent.KEYCODE_ESCAPE");
    // The same hardware requirements as the send rule, or a synthesised
    // Escape could interrupt a running agent.
    expect(interrupt).toContain("event.repeatCount == 0");
    expect(interrupt).toContain("isHardwareKeyboardEvent(event)");
    // Ungated by focus, on purpose, on both sides.
    const decision = kotlinRule("fun commandForKeyEvent(");
    expect(decision).toContain("isInterruptKeyEvent(event) -> COMMAND_CHAT_INTERRUPT");
    expect(decision).not.toMatch(/isChatComposerFocused && isInterruptKeyEvent/);
  });

  it("asks one source for the hardware answer", () => {
    // Two callers asking the native bridge separately is how the auto-focus
    // and the send rule came to disagree on Android, back when nothing there
    // answered and the one-shot returned false forever.
    expect(SCREEN_SOURCE).not.toContain("getNativeHardwareKeyboardConnected");
    expect(SCREEN_SOURCE).toContain("useHasHardwareKeyboard()");
  });
});
