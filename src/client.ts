import { createConnection } from "node:net";
import {
  encodeMessage,
  parseMessages,
  MSG_DATA,
  MSG_DISCONNECT,
  MSG_CLIENT_DATA,
  MSG_CLIENT_RESIZE,
  MSG_CLIENT_DETACH,
  MSG_CLIENT_HELLO,
} from "./terminal-io.js";

/** Connect to a running aimux server and attach as a thin client */
export function attachToServer(socketPath: string): void {
  const socket = createConnection(socketPath);
  let recvBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let rawModeWas: boolean | undefined;

  const enterRawMode = () => {
    if (process.stdin.isTTY) {
      rawModeWas = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
  };

  const exitRawMode = () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(rawModeWas ?? false);
      process.stdin.pause();
    }
  };

  const detach = () => {
    socket.write(encodeMessage(MSG_CLIENT_DETACH, Buffer.alloc(0)));
    exitRawMode();
    console.log("\nDetached from aimux server.");
    process.exit(0);
  };

  socket.on("connect", () => {
    enterRawMode();

    // Send HELLO with terminal dimensions
    const hello = JSON.stringify({
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      cwd: process.cwd(),
    });
    socket.write(encodeMessage(MSG_CLIENT_HELLO, hello));

    // Forward local stdin to server
    process.stdin.on("data", (data: Buffer) => {
      // Detach key: Ctrl+\ (0x1c)
      if (data.length === 1 && data[0] === 0x1c) {
        detach();
        return;
      }
      socket.write(encodeMessage(MSG_CLIENT_DATA, data));
    });

    // Forward SIGWINCH (terminal resize) to server
    process.stdout.on("resize", () => {
      const buf = Buffer.alloc(4);
      buf.writeUInt16BE(process.stdout.columns ?? 80, 0);
      buf.writeUInt16BE(process.stdout.rows ?? 24, 2);
      socket.write(encodeMessage(MSG_CLIENT_RESIZE, buf));
    });
  });

  // Handle messages from server
  socket.on("data", (chunk: Buffer) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    const { messages, remaining } = parseMessages(recvBuf);
    recvBuf = remaining;

    for (const msg of messages) {
      switch (msg.type) {
        case MSG_DATA:
          process.stdout.write(msg.payload);
          break;
        case MSG_DISCONNECT:
          exitRawMode();
          console.log("\nServer disconnected.");
          process.exit(0);
          break;
      }
    }
  });

  socket.on("close", () => {
    exitRawMode();
    console.log("\nConnection to aimux server lost.");
    process.exit(1);
  });

  socket.on("error", (err) => {
    exitRawMode();
    console.error(`Failed to connect to aimux server: ${err.message}`);
    process.exit(1);
  });
}
