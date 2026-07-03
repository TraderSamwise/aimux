import { getDaemonBaseUrl, loadDaemonInfo } from "./daemon-state.js";
import { requestJson } from "./http-client.js";

export async function requestDaemonJson(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const info = loadDaemonInfo();
  if (!info) {
    throw new Error("aimux daemon is not running");
  }
  const { status, json } = await requestJson(`${getDaemonBaseUrl(info.port)}${path}`, {
    method: init?.method,
    headers: init?.headers as Record<string, string> | undefined,
    body: init?.body,
    timeoutMs: init?.timeoutMs,
  });
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `daemon request failed: ${status}`);
  }
  return json;
}
