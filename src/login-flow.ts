// Browser-based `aimux login` flow.
//
// Mirrors the `gh auth login` / `vercel login` pattern:
//   1. Spin up a localhost callback server on an ephemeral port.
//   2. Open the browser to the web app's /cli-auth page, passing the callback.
//   3. The web app signs the user in via Clerk, calls the relay to mint a
//      long-lived daemon token, and redirects to the callback with the token.
//   4. We capture the token, persist it, and shut the server down.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { saveCredentials } from "./credentials.js";

const DEFAULT_WEB_APP_URL = "https://aimux.com";
const DEFAULT_RELAY_URL = "wss://relay.aimux.com";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Browser open is best-effort; the URL is also printed for manual open.
  }
}

export interface LoginOptions {
  webAppUrl?: string;
}

export async function runLoginFlow(opts: LoginOptions = {}): Promise<{ userId: string }> {
  // Relay URL is read from env only (no CLI override): the daemon token is
  // minted by whichever relay the web app uses, so it has to be the same
  // one the daemon then connects to — pinning it to env keeps both ends in
  // sync.
  const webAppUrl = (opts.webAppUrl ?? process.env.AIMUX_WEB_APP_URL ?? DEFAULT_WEB_APP_URL).replace(/\/$/, "");
  const relayUrl = (process.env.AIMUX_RELAY_URL ?? DEFAULT_RELAY_URL).replace(/\/$/, "");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, LOGIN_TIMEOUT_MS);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const token = url.searchParams.get("token");
      const userId = url.searchParams.get("userId");
      const error = url.searchParams.get("error");

      // Respond to the browser first so the user sees a friendly page.
      res.statusCode = error ? 400 : 200;
      res.setHeader("content-type", "text/html");
      res.end(
        error
          ? `<html><body style="font-family:system-ui;text-align:center;padding-top:80px"><h2>Login failed</h2><p>${escapeHtml(error)}</p><p>You can close this tab and try again.</p></body></html>`
          : `<html><body style="font-family:system-ui;text-align:center;padding-top:80px"><h2>✓ Logged in to aimux</h2><p>You can close this tab and return to the terminal.</p></body></html>`,
      );

      clearTimeout(timer);
      server.close();

      if (error) {
        reject(new Error(error));
        return;
      }
      if (!token || !userId) {
        reject(new Error("Callback missing token or userId"));
        return;
      }

      saveCredentials({
        version: 1,
        relayUrl,
        token,
        userId,
        createdAt: new Date().toISOString(),
        remoteEnabled: true,
      });
      resolve({ userId });
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const callback = `http://127.0.0.1:${port}/callback`;
      const authUrl = `${webAppUrl}/cli-auth?callback=${encodeURIComponent(callback)}`;
      console.log("Opening your browser to sign in...");
      console.log(`If it doesn't open, visit:\n  ${authUrl}\n`);
      openBrowser(authUrl);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
