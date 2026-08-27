import type { Socket } from "node:net";

const EXPOSE_SOCKET_HEADER_LINES = 15;
const EXPOSE_SOCKET_HEADER_MAX_BYTES = 8192;
const EXPOSE_SOCKET_HEADER_TIMEOUT_MS = 2000;

export function parsePositiveHeaderInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function splitExposeHeader(buffer: Buffer): { header: string[]; rest: Buffer } | null {
  let newlineCount = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 10) continue;
    newlineCount += 1;
    if (newlineCount !== EXPOSE_SOCKET_HEADER_LINES) continue;
    const header = buffer
      .subarray(0, index)
      .toString("utf8")
      .split("\n")
      .map((line) => line.replace(/\r$/, ""));
    return { header, rest: buffer.subarray(index + 1) };
  }
  return null;
}

export async function readExposeSocketHeader(socket: Socket): Promise<{ header: string[]; rest: Buffer }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("timed out reading expose socket launch header"));
    }, EXPOSE_SOCKET_HEADER_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("expose socket closed before launch header"));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > EXPOSE_SOCKET_HEADER_MAX_BYTES) {
        cleanup();
        socket.destroy();
        reject(new Error("expose socket launch header is too large"));
        return;
      }
      const parsed = splitExposeHeader(Buffer.concat(chunks, total));
      if (!parsed) return;
      cleanup();
      resolve(parsed);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}
