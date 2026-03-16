import { existsSync, mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { getAimuxDir } from "./config.js";

/**
 * Strip all terminal escape sequences from PTY output, not just colors.
 * Handles: SGR (colors), cursor movement, cursor position, erase,
 * scroll, OSC (title), and other CSI/SS3/DCS sequences.
 * Also converts cursor-right (\x1b[nC) to spaces for readable output.
 */
function stripTerminal(data: string): string {
  let result = "";
  let i = 0;
  while (i < data.length) {
    const ch = data[i];

    if (ch === "\x1b") {
      const next = data[i + 1];

      if (next === "[") {
        // CSI sequence: \x1b[ ... <final byte>
        let j = i + 2;
        // Parse parameter bytes (0x30-0x3f) and intermediate bytes (0x20-0x2f)
        while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++;
        while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x2f) j++;
        // Final byte
        if (j < data.length) {
          const finalByte = data[j];
          // Cursor right: convert to spaces for readable text
          if (finalByte === "C") {
            const params = data.slice(i + 2, j);
            const n = parseInt(params) || 1;
            result += " ".repeat(n);
          }
          // All other CSI sequences (cursor move, erase, scroll, SGR) → skip
          j++;
        }
        i = j;
        continue;
      }

      if (next === "]") {
        // OSC sequence: \x1b] ... (terminated by BEL \x07 or ST \x1b\\)
        let j = i + 2;
        while (j < data.length) {
          if (data[j] === "\x07") {
            j++;
            break;
          }
          if (data[j] === "\x1b" && data[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }

      if (next === "(" || next === ")" || next === "*" || next === "+") {
        // Character set designation: \x1b( <char> — skip 3 bytes
        i += 3;
        continue;
      }

      if (next === "P") {
        // DCS sequence: \x1bP ... ST
        let j = i + 2;
        while (j < data.length) {
          if (data[j] === "\x1b" && data[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }

      // Single-char escape (save/restore cursor, etc.): \x1b <char>
      i += 2;
      continue;
    }

    // Strip other control chars except newline, carriage return, tab
    const code = ch.charCodeAt(0);
    if (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) {
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  // Clean up carriage returns: keep only content after last \r per line
  return result
    .split("\n")
    .map((line) => {
      const lastCr = line.lastIndexOf("\r");
      return lastCr >= 0 ? line.slice(lastCr + 1) : line;
    })
    .join("\n");
}

export class Recorder {
  private rawStream: WriteStream;
  private txtStream: WriteStream;
  private _rawPath: string;
  private _txtPath: string;

  constructor(sessionId: string, cwd?: string) {
    const recordingsDir = join(getAimuxDir(cwd), "recordings");
    if (!existsSync(recordingsDir)) {
      mkdirSync(recordingsDir, { recursive: true });
    }

    this._rawPath = join(recordingsDir, `${sessionId}.log`);
    this._txtPath = join(recordingsDir, `${sessionId}.txt`);

    this.rawStream = createWriteStream(this._rawPath, { flags: "a" });
    this.txtStream = createWriteStream(this._txtPath, { flags: "a" });
  }

  get rawPath(): string {
    return this._rawPath;
  }

  get txtPath(): string {
    return this._txtPath;
  }

  /**
   * Record PTY output data. Writes raw (with ANSI) and stripped (plaintext).
   */
  write(data: string): void {
    this.rawStream.write(data);
    this.txtStream.write(stripTerminal(data));
  }

  close(): void {
    this.rawStream.end();
    this.txtStream.end();
  }
}
