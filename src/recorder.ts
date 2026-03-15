import { existsSync, mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { getAimuxDir } from "./config.js";

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
    this.txtStream.write(stripAnsi(data));
  }

  close(): void {
    this.rawStream.end();
    this.txtStream.end();
  }
}
