import type { Env } from "./types.js";
import type { SecurityDeviceRecord, SecurityEventRecord, SecurityPushTokenRecord } from "./security.js";

interface DeliveryInput {
  env: Env;
  userId: string;
  event: SecurityEventRecord;
  device?: SecurityDeviceRecord;
  pushTokens: SecurityPushTokenRecord[];
  emergencyUrl?: string;
  excludeDeviceId?: string;
}

interface ClerkUserResponse {
  primary_email_address_id?: string;
  email_addresses?: Array<{ id: string; email_address: string }>;
}

export type SecurityDeliveryChannel = "email" | "push";
export type SecurityDeliveryStatus = "delivered" | "skipped" | "failed";

export interface SecurityDeliveryChannelResult {
  channel: SecurityDeliveryChannel;
  status: SecurityDeliveryStatus;
  sent: number;
  reason?: string;
}

export interface SecurityDeliveryResult {
  delivered: boolean;
  channels: SecurityDeliveryChannelResult[];
}

export async function deliverSecurityAlert(input: DeliveryInput): Promise<SecurityDeliveryResult> {
  const channels = await Promise.all([
    settleDelivery("email", () => sendSecurityEmail(input)),
    settleDelivery("push", () => sendSecurityPush(input)),
  ]);
  const result = {
    delivered: channels.some((channel) => channel.status === "delivered"),
    channels,
  };
  const failed = channels.filter((channel) => channel.status === "failed");
  if (!result.delivered) {
    console.error("security alert delivery failed: no channel delivered", deliverySummary(channels));
  } else if (failed.length > 0) {
    console.warn("security alert delivery degraded", deliverySummary(channels));
  }
  return result;
}

export interface NotificationPushInput {
  userId: string;
  pushTokens: SecurityPushTokenRecord[];
  title: string;
  body: string;
  kind?: string;
  sessionId?: string;
  projectId?: string;
  projectRoot?: string;
  dedupeKey?: string;
}

export async function deliverNotificationPush(input: NotificationPushInput): Promise<{ sent: number }> {
  const messages = input.pushTokens
    .filter((record) => record.userId === input.userId)
    .filter((record) => record.platform === "ios" || record.platform === "android")
    .filter((record) => record.agentAlerts !== false)
    .map((record) => ({
      to: record.token,
      title: input.title,
      body: input.body,
      priority: "high",
      ...(record.platform === "android" ? { channelId: "security" } : {}),
      // sound and interruptionLevel are iOS-only in the Expo push API.
      ...(record.platform === "ios" ? { sound: "default", interruptionLevel: "time-sensitive" } : {}),
      data: {
        category: "agent",
        kind: input.kind,
        sessionId: input.sessionId,
        projectId: input.projectId,
        projectRoot: input.projectRoot,
        dedupeKey: input.dedupeKey,
      },
    }));
  return sendExpoPush(messages);
}

async function sendExpoPush(messages: unknown[]): Promise<{ sent: number }> {
  if (messages.length === 0) return { sent: 0 };
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messages),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Expo push failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  let body: {
    data?: Array<{ status?: string; message?: string; details?: unknown }>;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    throw new Error(`Expo push returned unreadable success response: ${errorMessage(error)}`, { cause: error });
  }
  if (!Array.isArray(body.data)) {
    throw new Error("Expo push returned invalid success response: missing data tickets");
  }
  if (body.data.length !== messages.length) {
    throw new Error(`Expo push returned ${body.data.length} tickets for ${messages.length} messages`);
  }
  const failedTicket = body.data.find((ticket) => ticket.status === "error");
  if (failedTicket) {
    const detail = failedTicket.message || (failedTicket.details ? JSON.stringify(failedTicket.details) : "");
    throw new Error(`Expo push rejected a token${detail ? `: ${detail}` : ""}`);
  }
  return { sent: messages.length };
}

async function sendSecurityEmail(input: DeliveryInput): Promise<{ sent: number; skippedReason?: string }> {
  if (!input.env.RESEND_API_KEY || !input.env.SECURITY_EMAIL_FROM || !input.env.CLERK_SECRET_KEY) {
    return { sent: 0, skippedReason: "security email not configured" };
  }
  const email = await fetchPrimaryEmail(input.env, input.userId);
  if (!email) return { sent: 0, skippedReason: "owner email not found" };
  const html = renderSecurityEmail(input.event, input.device, input.emergencyUrl);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: input.env.SECURITY_EMAIL_FROM,
      to: [email],
      subject: input.event.title,
      html,
      text: securityEmailText(input.event, input.emergencyUrl),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend email failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return { sent: 1 };
}

async function fetchPrimaryEmail(env: Env, userId: string): Promise<string | null> {
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Clerk user lookup failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const user = (await res.json()) as ClerkUserResponse;
  const primary = user.email_addresses?.find((email) => email.id === user.primary_email_address_id);
  return primary?.email_address ?? user.email_addresses?.[0]?.email_address ?? null;
}

async function sendSecurityPush(input: DeliveryInput): Promise<{ sent: number; skippedReason?: string }> {
  const excludeDeviceId = input.excludeDeviceId ?? input.device?.id;
  const messages = input.pushTokens
    .filter((record) => !record.userId || record.userId === input.userId)
    .filter((record) => record.deviceId !== excludeDeviceId)
    .map((record) => ({
      to: record.token,
      title: input.event.title,
      body: input.event.body,
      ...(record.platform === "android" ? { channelId: "security" } : {}),
      data: {
        category: "security",
        kind: input.event.kind,
        deviceId: input.device?.id,
        shareId: input.event.shareId,
        sessionId: input.event.sessionId,
        emergencyUrl: input.emergencyUrl,
      },
    }));
  if (messages.length === 0) return { sent: 0, skippedReason: "no eligible push tokens" };
  return sendExpoPush(messages);
}

async function settleDelivery(
  channel: SecurityDeliveryChannel,
  run: () => Promise<{ sent: number; skippedReason?: string }>,
): Promise<SecurityDeliveryChannelResult> {
  try {
    const result = await run();
    if (result.sent > 0) {
      return { channel, status: "delivered", sent: result.sent };
    }
    return {
      channel,
      status: "skipped",
      sent: 0,
      reason: result.skippedReason ?? "no delivery attempted",
    };
  } catch (error) {
    return { channel, status: "failed", sent: 0, reason: errorMessage(error) };
  }
}

function deliverySummary(channels: SecurityDeliveryChannelResult[]): string {
  return channels
    .map((channel) => {
      const reason = channel.reason ? `: ${channel.reason}` : "";
      return `${channel.channel}=${channel.status}${channel.sent ? `(${channel.sent})` : ""}${reason}`;
    })
    .join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderSecurityEmail(
  event: SecurityEventRecord,
  device: SecurityDeviceRecord | undefined,
  emergencyUrl: string | undefined,
): string {
  const deviceName = device ? escapeHtml(device.name || device.platform || device.kind) : null;
  const body = escapeHtml(event.body);
  const emergency = emergencyUrl
    ? `<p><a href="${escapeHtml(emergencyUrl)}" style="color:#b91c1c;font-weight:700">This was not me - disable remote access</a></p>`
    : "";
  const deviceRow = deviceName ? `<p><strong>Device:</strong> ${deviceName}</p>` : "";
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5">
      <h2>${escapeHtml(event.title)}</h2>
      <p>${body}</p>
      ${deviceRow}
      <p><strong>Time:</strong> ${escapeHtml(event.createdAt)}</p>
      ${emergency}
      <p style="color:#666;font-size:13px">If this was you, no action is needed.</p>
    </div>
  `;
}

function securityEmailText(event: SecurityEventRecord, emergencyUrl: string | undefined): string {
  return [
    event.title,
    "",
    event.body,
    `Time: ${event.createdAt}`,
    emergencyUrl ? `This was not me: ${emergencyUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
