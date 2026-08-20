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
      // A real person to answer keeps this out of the bulk-mail bucket, and the
      // invitee usually wants to ask the owner something anyway.
      ...(input.owner.email ? { reply_to: input.owner.email } : {}),
      subject: `${input.owner.displayName} invited you to an aimux chat`,
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
  const inviter = escapeHtml(input.owner.email ?? input.owner.displayName);
  const project = projectName(input.share.projectRoot);
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5">
      <p>Hi,</p>
      <p>
        ${inviter} invited you to join an aimux chat with the agent
        <strong>${escapeHtml(input.share.sessionId)}</strong>${project ? ` on <strong>${escapeHtml(project)}</strong>` : ""}.
        You can read the conversation and reply to the agent from your browser.
      </p>
      <p><a href="${escapeHtml(input.acceptUrl)}" style="color:#2563eb;font-weight:700">Accept the invite</a></p>
      <p style="color:#666;font-size:13px">
        Or paste this link into your browser:<br />
        ${escapeHtml(input.acceptUrl)}
      </p>
      <p style="color:#666;font-size:13px">
        This invite is scoped to that one chat and nothing else in ${inviter}'s account.
        If you were not expecting it, you can ignore this email.
      </p>
    </div>
  `;
}

/** The repository name an invitee would recognise, not the owner's full path. */
function projectName(projectRoot: string): string {
  const trimmed = projectRoot.replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function shareInviteEmailText(input: ShareInviteDeliveryInput): string {
  const inviter = input.owner.email ?? input.owner.displayName;
  const project = projectName(input.share.projectRoot);
  return [
    "Hi,",
    "",
    `${inviter} invited you to join an aimux chat with the agent ${input.share.sessionId}` +
      `${project ? ` on ${project}` : ""}.`,
    "You can read the conversation and reply to the agent from your browser.",
    "",
    `Accept the invite: ${input.acceptUrl}`,
    "",
    `This invite is scoped to that one chat and nothing else in ${inviter}'s account.`,
    "If you were not expecting it, you can ignore this email.",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
