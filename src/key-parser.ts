/**
 * Terminal CSI escape sequence parser.
 *
 * Normalizes raw terminal key sequences into a clean KeyEvent format.
 * Handles xterm modifyOtherKeys, kitty keyboard protocol, and standard CSI.
 *
 * This is the single choke point for all terminal key handling —
 * swap this module to change the parsing strategy.
 */

export interface KeyEvent {
  /** The printable character, or empty for special keys */
  char: string;
  /** Named key: "enter", "tab", "backspace", "escape", "up", "down", "left", "right", "home", "end", "delete", "pageup", "pagedown", "f1"-"f12" */
  name: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** The raw input string (for debugging) */
  raw: string;
}

// Modifier bitmask (shared by xterm and standard CSI):
// 1=none, 2=shift, 3=alt, 4=shift+alt, 5=ctrl, 6=ctrl+shift, 7=ctrl+alt, 8=ctrl+shift+alt
function parseModifier(mod: number): { shift: boolean; ctrl: boolean; alt: boolean } {
  const m = mod - 1; // convert to 0-based bitmask
  return {
    shift: !!(m & 1),
    alt: !!(m & 2),
    ctrl: !!(m & 4),
  };
}

const KEYCODE_NAMES: Record<number, string> = {
  9: "tab",
  13: "enter",
  27: "escape",
  127: "backspace",
};

const CSI_FINAL_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CSI_TILDE_NAMES: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

/**
 * Parse raw stdin data into KeyEvents.
 * Returns an array because a single stdin chunk can contain multiple key sequences.
 */
export function parseKeys(data: Buffer | string): KeyEvent[] {
  const str = typeof data === "string" ? data : data.toString("utf-8");
  const events: KeyEvent[] = [];
  let i = 0;

  while (i < str.length) {
    // ESC sequence
    if (str[i] === "\x1b") {
      // Bracketed paste: ESC [200~ ... ESC [201~
      // Terminals wrap pasted text in these markers
      if (str.startsWith("\x1b[200~", i)) {
        const pasteStart = i + 6; // skip ESC [200~
        const pasteEnd = str.indexOf("\x1b[201~", pasteStart);
        const content = pasteEnd >= 0
          ? str.slice(pasteStart, pasteEnd)
          : str.slice(pasteStart); // no end marker yet — take everything
        if (content) {
          events.push({ char: content, name: "paste", shift: false, ctrl: false, alt: false, raw: content });
        }
        i = pasteEnd >= 0 ? pasteEnd + 6 : str.length;
        continue;
      }

      // CSI: ESC [
      if (i + 1 < str.length && str[i + 1] === "[") {
        const parsed = parseCSI(str, i + 2);
        if (parsed) {
          parsed.event.raw = str.slice(i, i + 2 + parsed.consumed);
          events.push(parsed.event);
          i += 2 + parsed.consumed;
          continue;
        }
      }

      // SS3: ESC O (used by some terminals for arrow keys, function keys)
      if (i + 1 < str.length && str[i + 1] === "O") {
        if (i + 2 < str.length) {
          const ch = str[i + 2];
          const name = CSI_FINAL_NAMES[ch];
          if (name) {
            events.push({ char: "", name, shift: false, ctrl: false, alt: false, raw: str.slice(i, i + 3) });
            i += 3;
            continue;
          }
          // SS3 P-S = F1-F4
          if (ch >= "P" && ch <= "S") {
            const fNum = ch.charCodeAt(0) - "P".charCodeAt(0) + 1;
            events.push({ char: "", name: `f${fNum}`, shift: false, ctrl: false, alt: false, raw: str.slice(i, i + 3) });
            i += 3;
            continue;
          }
        }
      }

      // ESC + single char = Alt+char (meta key)
      if (i + 1 < str.length && str[i + 1] !== "\x1b") {
        const ch = str[i + 1];
        const code = ch.charCodeAt(0);
        // Map control characters to their names (e.g., 0x7F = backspace, 0x0D = enter)
        const ctrlName = code === 127 || code === 8 ? "backspace"
          : code === 13 || code === 10 ? "enter"
          : code === 9 ? "tab"
          : code < 32 ? String.fromCharCode(code + 96) // Ctrl+letter
          : "";
        events.push({
          char: ctrlName ? "" : ch,
          name: ctrlName || ch,
          shift: false,
          ctrl: ctrlName !== "" && code < 32 && code !== 13 && code !== 10 && code !== 9 && code !== 8,
          alt: true,
          raw: str.slice(i, i + 2),
        });
        i += 2;
        continue;
      }

      // Lone ESC
      events.push({ char: "", name: "escape", shift: false, ctrl: false, alt: false, raw: "\x1b" });
      i++;
      continue;
    }

    // Control characters
    const code = str.charCodeAt(i);
    if (code < 32 || code === 127) {
      if (code === 13 || code === 10) {
        events.push({ char: "", name: "enter", shift: false, ctrl: false, alt: false, raw: str[i] });
      } else if (code === 9) {
        events.push({ char: "", name: "tab", shift: false, ctrl: false, alt: false, raw: str[i] });
      } else if (code === 127 || code === 8) {
        events.push({ char: "", name: "backspace", shift: false, ctrl: false, alt: false, raw: str[i] });
      } else {
        // Ctrl+letter: Ctrl+A = 1, Ctrl+B = 2, ..., Ctrl+Z = 26
        const letter = String.fromCharCode(code + 96); // 1 -> 'a', etc.
        events.push({ char: "", name: letter, shift: false, ctrl: true, alt: false, raw: str[i] });
      }
      i++;
      continue;
    }

    // Regular printable character(s) — batch consecutive printable chars
    let end = i + 1;
    while (end < str.length && str.charCodeAt(end) >= 32 && str[end] !== "\x1b") {
      end++;
    }
    const chars = str.slice(i, end);
    events.push({ char: chars, name: "", shift: false, ctrl: false, alt: false, raw: chars });
    i = end;
  }

  return events;
}

/**
 * Parse CSI sequence parameters (after ESC [).
 * Returns the parsed event and number of characters consumed after "ESC [".
 */
function parseCSI(str: string, start: number): { event: KeyEvent; consumed: number } | null {
  // Collect parameter bytes (digits and semicolons) and the final byte
  let i = start;
  let params = "";

  // Collect parameter bytes: 0x30-0x3F (digits, semicolons, etc.)
  while (i < str.length && str.charCodeAt(i) >= 0x30 && str.charCodeAt(i) <= 0x3f) {
    params += str[i];
    i++;
  }

  // Final byte: 0x40-0x7E
  if (i >= str.length) return null;
  const finalByte = str[i];
  const finalCode = finalByte.charCodeAt(0);
  if (finalCode < 0x40 || finalCode > 0x7e) return null;

  const consumed = i - start + 1;
  const parts = params.split(";").map(Number);

  // Kitty keyboard protocol: ESC [ keycode ; modifier u
  if (finalByte === "u") {
    const keycode = parts[0] ?? 0;
    const mods = parseModifier(parts[1] ?? 1);
    const name = KEYCODE_NAMES[keycode] ?? "";
    const char = name ? "" : String.fromCharCode(keycode);
    return {
      event: { char, name: name || char, ...mods, raw: "" },
      consumed,
    };
  }

  // xterm modifyOtherKeys: ESC [ 27 ; modifier ; keycode ~
  if (finalByte === "~" && parts[0] === 27 && parts.length >= 3) {
    const mods = parseModifier(parts[1] ?? 1);
    const keycode = parts[2] ?? 0;
    const name = KEYCODE_NAMES[keycode] ?? "";
    const char = name ? "" : String.fromCharCode(keycode);
    return {
      event: { char, name: name || char, ...mods, raw: "" },
      consumed,
    };
  }

  // Standard CSI with tilde: ESC [ number ~ (with optional modifier)
  if (finalByte === "~") {
    const keyNum = parts[0] ?? 0;
    const mods = parseModifier(parts[1] ?? 1);
    const name = CSI_TILDE_NAMES[keyNum] ?? "";
    if (name) {
      return {
        event: { char: "", name, ...mods, raw: "" },
        consumed,
      };
    }
    return null;
  }

  // Standard CSI arrow/nav: ESC [ (modifier ;)? final
  // e.g., ESC [ 1 ; 2 A = Shift+Up
  const name = CSI_FINAL_NAMES[finalByte];
  if (name) {
    // Modifier is in the last param if there are two parts
    const mod = parts.length >= 2 ? parts[1] ?? 1 : 1;
    const mods = parseModifier(mod);
    return {
      event: { char: "", name, ...mods, raw: "" },
      consumed,
    };
  }

  return null;
}

/**
 * Check if a KeyEvent matches a key descriptor.
 * Examples: "ctrl+o", "shift+enter", "ctrl+shift+left", "alt+b"
 */
export function matchKey(event: KeyEvent, descriptor: string): boolean {
  const parts = descriptor.toLowerCase().split("+");
  const key = parts.pop()!;
  const wantCtrl = parts.includes("ctrl");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");

  return (
    event.ctrl === wantCtrl &&
    event.shift === wantShift &&
    event.alt === wantAlt &&
    (event.name === key || event.char === key)
  );
}
