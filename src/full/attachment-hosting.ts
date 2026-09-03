import { readFileSync } from "node:fs";
import { loadCredentials } from "./credentials.js";
import { relayHttpUrl, type HostedAttachmentForPublish, type PublishedAttachmentHostInput } from "../cli/attachment.js";
import { requestJson } from "../http-client.js";

export async function maybeHostPublishedAttachment(
  input: PublishedAttachmentHostInput,
): Promise<HostedAttachmentForPublish | undefined> {
  const creds = loadCredentials();
  if (!creds?.remoteEnabled) return undefined;
  let relayBase: string;
  try {
    relayBase = relayHttpUrl(creds.relayUrl);
  } catch {
    return undefined;
  }
  try {
    const bytes = readFileSync(input.sourcePath);
    const response = await requestJson<{
      ok?: boolean;
      error?: string;
      hostedAttachment?: HostedAttachmentForPublish;
    }>(`${relayBase}/attachments/hosted`, {
      method: "POST",
      timeoutMs: 15_000,
      headers: { authorization: `Bearer ${creds.token}` },
      body: {
        filename: input.filename,
        mimeType: input.mimeType,
        dataBase64: bytes.toString("base64"),
        sessionId: input.sessionId,
      },
    });
    if (response.status >= 400 || !response.json.ok || !response.json.hostedAttachment?.contentUrl) {
      console.error(
        `aimux: warning: relay attachment hosting failed${response.json.error ? `: ${response.json.error}` : ""}`,
      );
      return undefined;
    }
    return response.json.hostedAttachment;
  } catch (error) {
    console.error(
      `aimux: warning: relay attachment hosting failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
