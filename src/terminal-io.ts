import type { Socket } from "node:net";

/** Protocol message types: server → client */
export const MSG_DATA = 0x01;
export const MSG_DISCONNECT = 0x02;

/** Protocol message types: client → server */
export const MSG_CLIENT_DATA = 0x81;
export const MSG_CLIENT_RESIZE = 0x82;
export const MSG_CLIENT_DETACH = 0x83;
export const MSG_CLIENT_HELLO = 0x84;

/** Encode a protocol message: [4 bytes uint32 BE length][1 byte type][payload] */
export function encodeMessage(type: number, payload: Buffer | string): Buffer {
  const payloadBuf = typeof payload === "string" ? Buffer.from(payload) : payload;
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payloadBuf.length + 1, 0); // length includes the type byte
  header[4] = type;
  return Buffer.concat([header, payloadBuf]);
}

/** Parse messages from a buffer, returns parsed messages and any remaining bytes */
export function parseMessages(buf: Buffer<ArrayBufferLike>): {
  messages: Array<{ type: number; payload: Buffer<ArrayBufferLike> }>;
  remaining: Buffer<ArrayBufferLike>;
} {
  const messages: Array<{ type: number; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    if (offset + 4 + len > buf.length) break; // incomplete message
    const type = buf[offset + 4];
    const payload = buf.subarray(offset + 5, offset + 4 + len);
    messages.push({ type, payload });
    offset += 4 + len;
  }
  return { messages, remaining: buf.subarray(offset) };
}

export interface TerminalIO {
  write(data: string | Buffer): void;
  readonly columns: number;
  readonly rows: number;
  onInput(handler: (data: Buffer) => void): void;
  onResize(handler: () => void): void;
  removeInputHandler(): void;
  removeResizeHandler(): void;
  enterRawMode(): void;
  exitRawMode(): void;
  readonly isTTY: boolean;
}

export class DirectTerminalIO implements TerminalIO {
  private inputHandler: ((data: Buffer) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private rawModeWas: boolean | undefined;

  write(data: string | Buffer): void {
    process.stdout.write(data);
  }

  get columns(): number {
    return process.stdout.columns ?? 80;
  }

  get rows(): number {
    return process.stdout.rows ?? 24;
  }

  onInput(handler: (data: Buffer) => void): void {
    this.inputHandler = handler;
    process.stdin.on("data", handler);
  }

  onResize(handler: () => void): void {
    this.resizeHandler = handler;
    process.stdout.on("resize", handler);
  }

  removeInputHandler(): void {
    if (this.inputHandler) {
      process.stdin.removeListener("data", this.inputHandler);
      this.inputHandler = null;
    }
  }

  removeResizeHandler(): void {
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  enterRawMode(): void {
    if (process.stdin.isTTY) {
      this.rawModeWas = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
  }

  exitRawMode(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(this.rawModeWas ?? false);
      process.stdin.pause();
    }
  }

  get isTTY(): boolean {
    return !!process.stdin.isTTY;
  }
}

export class RemoteTerminalIO implements TerminalIO {
  private socket: Socket | null = null;
  private inputHandler: ((data: Buffer) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private _columns = 80;
  private _rows = 24;
  private recvBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  write(data: string | Buffer): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(encodeMessage(MSG_DATA, typeof data === "string" ? Buffer.from(data) : data));
  }

  get columns(): number {
    return this._columns;
  }

  get rows(): number {
    return this._rows;
  }

  onInput(handler: (data: Buffer) => void): void {
    this.inputHandler = handler;
  }

  onResize(handler: () => void): void {
    this.resizeHandler = handler;
  }

  removeInputHandler(): void {
    this.inputHandler = null;
  }

  removeResizeHandler(): void {
    this.resizeHandler = null;
  }

  enterRawMode(): void {
    // No-op for remote — client manages its own raw mode
  }

  exitRawMode(): void {
    // No-op for remote — client manages its own raw mode
  }

  get isTTY(): boolean {
    return true; // Remote clients are always TTY-like
  }

  /** Bind a client socket connection */
  bindSocket(socket: Socket): void {
    this.socket = socket;
    this.recvBuf = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
      const { messages, remaining } = parseMessages(this.recvBuf);
      this.recvBuf = remaining;

      for (const msg of messages) {
        switch (msg.type) {
          case MSG_CLIENT_DATA:
            this.inputHandler?.(msg.payload);
            break;
          case MSG_CLIENT_RESIZE: {
            const cols = msg.payload.readUInt16BE(0);
            const rows = msg.payload.readUInt16BE(2);
            this._columns = cols;
            this._rows = rows;
            this.resizeHandler?.();
            break;
          }
          case MSG_CLIENT_HELLO: {
            try {
              const hello = JSON.parse(msg.payload.toString());
              this._columns = hello.cols ?? 80;
              this._rows = hello.rows ?? 24;
              this.resizeHandler?.();
            } catch {}
            break;
          }
          case MSG_CLIENT_DETACH:
            this.unbindSocket();
            break;
        }
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
    });

    socket.on("error", () => {
      if (this.socket === socket) {
        this.socket = null;
      }
    });
  }

  /** Unbind the current socket (client detached) */
  unbindSocket(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(encodeMessage(MSG_DISCONNECT, Buffer.alloc(0)));
      this.socket.end();
    }
    this.socket = null;
  }

  /** Whether a client is currently connected */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Update dimensions (used when binding a new client) */
  setDimensions(cols: number, rows: number): void {
    this._columns = cols;
    this._rows = rows;
  }
}
