import type { Env } from "./types.js";
import type {
  SecurityDeviceRecord,
  SecurityEventRecord,
  SecurityPushTokenRecord,
} from "./security.js";

interface DeliveryInput {
  env: Env;
  userId: string;
  event: SecurityEventRecord;
  device: SecurityDeviceRecord;
  pushTokens: SecurityPushTokenRecord[];
  emergencyUrl?: string;
}

interface ClerkUserResponse {
  primary_email_address_id?: string;
  email_addresses?: Array<{ id: string; email_address: string }>;
}

export async function deliverSecurityAlert(input: DeliveryInput): Promise<void> {
  await Promise.allSettled([sendSecurityEmail(input), sendSecurityPush(input)]);
}

async function sendSecurityEmail(input: DeliveryInput): Promise<void> {
  if (!input.env.RESEND_API_KEY || !input.env.SECURITY_EMAIL_FROM || !input.env.CLERK_SECRET_KEY) return;
  const email = await fetchPrimaryEmail(input.env, input.userId);
  if (!email) return;
  const html = renderSecurityEmail(input.event, input.device, input.emergencyUrl);
  await fetch("https://api.resend.com/emails", {
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
}

async function fetchPrimaryEmail(env: Env, userId: string): Promise<string | null> {
  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as ClerkUserResponse;
  const primary = user.email_addresses?.find((email) => email.id === user.primary_email_address_id);
  return primary?.email_address ?? user.email_addresses?.[0]?.email_address ?? null;
}

async function sendSecurityPush(input: DeliveryInput): Promise<void> {
  const messages = input.pushTokens
    .filter((record) => record.deviceId !== input.device.id)
    .map((record) => ({
      to: record.token,
      title: input.event.title,
      body: input.event.body,
      data: {
        category: "security",
        kind: input.event.kind,
        deviceId: input.device.id,
        emergencyUrl: input.emergencyUrl,
      },
    }));
  if (messages.length === 0) return;
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messages),
  });
}

function renderSecurityEmail(
  event: SecurityEventRecord,
  device: SecurityDeviceRecord,
  emergencyUrl: string | undefined,
): string {
  const deviceName = escapeHtml(device.name || device.platform || device.kind);
  const body = escapeHtml(event.body);
  const emergency = emergencyUrl
    ? `<p><a href="${escapeHtml(emergencyUrl)}" style="color:#b91c1c;font-weight:700">This was not me - disable remote access</a></p>`
    : "";
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5">
      <h2>${escapeHtml(event.title)}</h2>
      <p>${body}</p>
      <p><strong>Device:</strong> ${deviceName}</p>
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
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
