export interface OscNotification {
  source: "osc9" | "osc99" | "osc777";
  title: string;
  body: string;
}

interface ParseResult {
  cleaned: string;
  notifications: OscNotification[];
}

interface KittyPending {
  title: string;
  body: string;
}

const ESC = "\u001b";
const BEL = "\u0007";
const DEFAULT_KITTY_ID = "__default__";

function decodeBase64Utf8(input: string): string {
  if (!input) return "";
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(input);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder().decode(bytes);
    }
    return binary;
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "base64").toString("utf8");
  }
  return input;
}

function looksLikeConEmuOsc9(payload: string): boolean {
  return /^(?:1|2|3|4|5|6|7|8|9|10|11|12)(?:;|$)/.test(payload);
}

function parseOsc9(payload: string): OscNotification | null {
  if (!payload || looksLikeConEmuOsc9(payload)) return null;
  return {
    source: "osc9",
    title: "",
    body: payload,
  };
}

function parseOsc777(payload: string): OscNotification | null {
  if (!payload.startsWith("notify;")) return null;
  const firstSep = payload.indexOf(";");
  const secondSep = payload.indexOf(";", firstSep + 1);
  if (secondSep === -1) return null;
  return {
    source: "osc777",
    title: payload.slice(firstSep + 1, secondSep),
    body: payload.slice(secondSep + 1),
  };
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  if (value[0] === "0") return false;
  if (value[0] === "1") return true;
  return defaultValue;
}

function isValidKittyId(value: string): boolean {
  return /^[A-Za-z0-9._:+-]+$/.test(value);
}

function parseOsc99(payload: string, kittyPending: Map<string, KittyPending>): OscNotification | null {
  const metaEnd = payload.indexOf(";");
  if (metaEnd === -1) return null;

  const meta = payload.slice(0, metaEnd);
  let rawPayload = payload.slice(metaEnd + 1);
  let payloadKind: "title" | "body" | "ignore" = "title";
  let done = true;
  let base64 = false;
  let id = DEFAULT_KITTY_ID;

  if (meta) {
    for (const part of meta.split(":")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (key === "p") {
        if (value === "title" || value === "body") payloadKind = value;
        else payloadKind = "ignore";
      } else if (key === "d") {
        done = parseBool(value, true);
      } else if (key === "e") {
        base64 = parseBool(value, false);
      } else if (key === "i" && isValidKittyId(value)) {
        id = value;
      }
    }
  }

  if (payloadKind === "ignore") return null;
  if (base64) {
    try {
      rawPayload = decodeBase64Utf8(rawPayload);
    } catch {
      return null;
    }
  }

  const pending = kittyPending.get(id) ?? { title: "", body: "" };
  if (payloadKind === "title") pending.title += rawPayload;
  else pending.body += rawPayload;

  if (!done) {
    kittyPending.set(id, pending);
    return null;
  }

  kittyPending.delete(id);
  const title = pending.title || (pending.body ? pending.body : "");
  const body = pending.title ? pending.body : "";
  if (!title && !body) return null;
  return {
    source: "osc99",
    title,
    body,
  };
}

function parseOscPayload(payload: string, kittyPending: Map<string, KittyPending>): OscNotification | null {
  const firstSep = payload.indexOf(";");
  const command = firstSep === -1 ? payload : payload.slice(0, firstSep);
  const rest = firstSep === -1 ? "" : payload.slice(firstSep + 1);

  if (command === "9") return parseOsc9(rest);
  if (command === "99") return parseOsc99(rest, kittyPending);
  if (command === "777") return parseOsc777(rest);
  return null;
}

export class OscNotificationParser {
  private buffer = "";
  private kittyPending = new Map<string, KittyPending>();

  parseChunk(chunk: string): ParseResult {
    const input = this.buffer + (chunk || "");
    const notifications: OscNotification[] = [];
    let cleaned = "";
    let index = 0;

    while (index < input.length) {
      const escIndex = input.indexOf(`${ESC}]`, index);
      if (escIndex === -1) {
        cleaned += input.slice(index);
        index = input.length;
        break;
      }

      cleaned += input.slice(index, escIndex);

      let end = -1;
      let terminatorLength = 0;
      for (let cursor = escIndex + 2; cursor < input.length; cursor += 1) {
        const ch = input[cursor];
        if (ch === BEL) {
          end = cursor;
          terminatorLength = 1;
          break;
        }
        if (ch === ESC && input[cursor + 1] === "\\") {
          end = cursor;
          terminatorLength = 2;
          break;
        }
      }

      if (end === -1) {
        this.buffer = input.slice(escIndex);
        return { cleaned, notifications };
      }

      const payload = input.slice(escIndex + 2, end);
      const notification = parseOscPayload(payload, this.kittyPending);
      if (notification) notifications.push(notification);
      index = end + terminatorLength;
    }

    this.buffer = "";
    return { cleaned, notifications };
  }
}
