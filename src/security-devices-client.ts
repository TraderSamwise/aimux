import { loadCredentials } from "./credentials.js";
import { requestJson } from "./http-client.js";

export interface RemoteSecurityDevice {
  id: string;
  deviceId: string;
  kind: "web" | "ios" | "android" | "daemon" | "unknown";
  name?: string;
  platform?: string;
  appVersion?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  approvedAt?: string;
  blockedAt?: string;
  lastCountry?: string;
  approved: boolean;
  blocked: boolean;
  approvalCode?: string;
}

export interface RemoteSecurityDevicesResponse {
  ok: boolean;
  devices?: RemoteSecurityDevice[];
  error?: string;
}

export interface RemoteSecurityDeviceResponse {
  ok: boolean;
  device?: RemoteSecurityDevice;
  error?: string;
}

export async function listRemoteSecurityDevices(): Promise<RemoteSecurityDevice[]> {
  const response = await securityRequest<RemoteSecurityDevicesResponse>("/security/devices", { method: "GET" });
  if (!response.ok || !response.devices) throw new Error(response.error ?? "Could not list remote devices");
  return response.devices;
}

export async function listLivePendingRemoteSecurityDevices(): Promise<RemoteSecurityDevice[]> {
  const response = await securityRequest<RemoteSecurityDevicesResponse>("/security/devices/pending", { method: "GET" });
  if (!response.ok || !response.devices) {
    throw new Error(response.error ?? "Could not list pending remote devices");
  }
  return response.devices;
}

export async function approveRemoteSecurityDevice(
  deviceId: string,
  approvalCode?: string,
): Promise<RemoteSecurityDevice> {
  return updateRemoteSecurityDevice(deviceId, "approve", approvalCode ? { approvalCode } : undefined);
}

export async function blockRemoteSecurityDevice(deviceId: string): Promise<RemoteSecurityDevice> {
  return updateRemoteSecurityDevice(deviceId, "block");
}

export async function unblockRemoteSecurityDevice(deviceId: string): Promise<RemoteSecurityDevice> {
  return updateRemoteSecurityDevice(deviceId, "unblock");
}

async function updateRemoteSecurityDevice(
  deviceId: string,
  action: "approve" | "block" | "unblock",
  body?: unknown,
): Promise<RemoteSecurityDevice> {
  const response = await securityRequest<RemoteSecurityDeviceResponse>(
    `/security/devices/${encodeURIComponent(deviceId)}/${action}`,
    { method: "POST", body },
  );
  if (!response.ok || !response.device) throw new Error(response.error ?? `Could not ${action} remote device`);
  return response.device;
}

async function securityRequest<T extends { ok?: boolean; error?: string }>(
  path: string,
  options: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const creds = loadCredentials();
  if (!creds) throw new Error("Not logged in. Run `aimux login` first.");
  const response = await requestJson<T>(`${relayHttpUrl(creds.relayUrl)}${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeoutMs: 15_000,
  });
  if (response.status >= 400) {
    throw new Error(response.json.error ?? `Relay returned ${response.status}`);
  }
  return response.json;
}

function relayHttpUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.toString().replace(/\/+$/, "");
}
