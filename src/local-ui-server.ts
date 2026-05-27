import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve as pathResolve, sep } from "node:path";
import { platform } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_LOCAL_UI_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_UI_PORT = 43192;

export interface LocalUiConfig {
  connectionMode: "local";
  daemonUrl: string;
}

export interface LocalUiServerOptions {
  host?: string;
  port?: number;
  uiRoot?: string;
  config: LocalUiConfig;
}

export interface LocalUiServerHandle {
  host: string;
  port: number;
  url: string;
  uiRoot: string;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function packageRoot(): string {
  return pathResolve(fileURLToPath(import.meta.url), "..", "..");
}

export function resolveDefaultLocalUiRoot(): string {
  return pathResolve(packageRoot(), "dist-ui");
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "127.0.0.1";
}

function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function localConfigJavascript(config: LocalUiConfig): string {
  return `window.__AIMUX_LOCAL_CONFIG__=${JSON.stringify(config)};\n`;
}

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = pathResolve(root);
  const resolvedTarget = pathResolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`);
}

function resolveRequestPath(uiRoot: string, req: IncomingMessage): string | null {
  const rawPath = (req.url ?? "/").split(/[?#]/, 1)[0] ?? "/";
  try {
    if (decodeURIComponent(rawPath).split("/").includes("..")) return null;
  } catch {
    return null;
  }
  const url = new URL(req.url ?? "/", "http://local.aimux");
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  if (pathname === "/") pathname = "/index.html";
  const target = pathResolve(uiRoot, `.${pathname}`);
  if (!isInsideRoot(uiRoot, target)) return null;
  return target;
}

function serveFile(req: IncomingMessage, res: ServerResponse, path: string): void {
  const ext = extname(path).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const isIndex = ext === ".html";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path)
    .on("error", () => {
      if (!res.headersSent) send(res, 500, "Internal server error");
      else res.destroy();
    })
    .pipe(res);
}

function requestHandler(uiRoot: string, config: LocalUiConfig): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    setCommonHeaders(res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "Method not allowed");
      return;
    }

    const url = new URL(req.url ?? "/", "http://local.aimux");
    if (url.pathname === "/aimux-local-config.js") {
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : localConfigJavascript(config));
      return;
    }

    const target = resolveRequestPath(uiRoot, req);
    if (!target) {
      send(res, 403, "Forbidden");
      return;
    }

    if (existsSync(target) && statSync(target).isFile()) {
      serveFile(req, res, target);
      return;
    }

    if (!extname(new URL(req.url ?? "/", "http://local.aimux").pathname)) {
      const indexPath = pathResolve(uiRoot, "index.html");
      if (existsSync(indexPath)) {
        serveFile(req, res, indexPath);
        return;
      }
    }

    send(res, 404, "Not found");
  };
}

export async function startLocalUiServer(options: LocalUiServerOptions): Promise<LocalUiServerHandle> {
  const host = options.host ?? DEFAULT_LOCAL_UI_HOST;
  const port = options.port ?? DEFAULT_LOCAL_UI_PORT;
  if (!isLoopbackHost(host)) {
    throw new Error(`Local UI host must be loopback (127.0.0.1, localhost, or ::1), got ${host}`);
  }
  const uiRoot = pathResolve(options.uiRoot ?? resolveDefaultLocalUiRoot());
  const indexPath = pathResolve(uiRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`Local UI build not found at ${uiRoot}. Run yarn build:ui:local first.`);
  }

  const server = createServer(requestHandler(uiRoot, options.config));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${formatHostForUrl(host)}:${actualPort}`;
  return {
    host,
    port: actualPort,
    url,
    uiRoot,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function openUrlInBrowser(url: string): void {
  const os = platform();
  const command = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open";
  const args = os === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
