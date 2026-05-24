import type { Env } from "./types.js";
import type { ShareActor, SharedSessionRecord } from "./sharing.js";

export interface ShareInviteDeliveryInput {
  env: Env;
  owner: ShareActor;
  share: SharedSessionRecord;
  inviteEmail: string;
  acceptUrl: string;
}

export async function deliverShareInvite(input: ShareInviteDeliveryInput): Promise<boolean> {
  if (!input.env.RESEND_API_KEY) return false;
  const from = input.env.COLLAB_EMAIL_FROM ?? input.env.SECURITY_EMAIL_FROM;
  if (!from) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.inviteEmail],
      subject: `${input.owner.displayName} invited you to aimux`,
      html: renderShareInviteEmail(input),
      text: shareInviteEmailText(input),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Share invite email failed: ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
  }
  return true;
}

function renderShareInviteEmail(input: ShareInviteDeliveryInput): string {
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5">
      <h2>${escapeHtml(input.owner.displayName)} invited you to aimux</h2>
      <p>You were invited to join an aimux chat for session <strong>${escapeHtml(input.share.sessionId)}</strong>.</p>
      <p><a href="${escapeHtml(input.acceptUrl)}" style="color:#2563eb;font-weight:700">Accept invite</a></p>
      <p style="color:#666;font-size:13px">This invite is scoped to one agent chat. If you did not expect it, ignore this email.</p>
    </div>
  `;
}

function shareInviteEmailText(input: ShareInviteDeliveryInput): string {
  return [
    `${input.owner.displayName} invited you to aimux`,
    "",
    `Session: ${input.share.sessionId}`,
    `Accept invite: ${input.acceptUrl}`,
    "",
    "This invite is scoped to one agent chat. If you did not expect it, ignore this email.",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
