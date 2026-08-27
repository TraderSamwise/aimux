import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { basename, extname, resolve as pathResolve } from "node:path";
import { assertPublishableSource } from "../attachment-store.js";
import { loadCredentials } from "../credentials.js";
import { requestJson } from "../http-client.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import type { WorktreeInfo } from "../worktree.js";

export interface HostedAttachmentForPublish {
  contentUrl: string;
  expiresAt: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface PublishedAttachmentHostInput {
  sourcePath: string;
  filename: string;
  mimeType: string;
  sessionId: string;
}

export interface RegisterAttachmentCommandDeps {
  prepareProjectContext: (requestedProject?: string) => Promise<string>;
  postProjectServiceJson: (path: string, body: unknown, opts?: { projectRoot?: string }) => Promise<any>;
  listWorktrees: (projectRoot: string) => WorktreeInfo[];
  hostPublishedAttachment?: (input: PublishedAttachmentHostInput) => Promise<HostedAttachmentForPublish | undefined>;
}

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

export function relayHttpUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.toString().replace(/\/+$/, "");
}

export function mimeTypeForPublishedAttachment(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const known = publishMimeTypes.get(extension);
  return known ?? "application/octet-stream";
}

const publishMimeTypes = new Map([
  [".aac", "audio/aac"],
  [".csv", "text/csv"],
  [".flac", "audio/flac"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".m4a", "audio/m4a"],
  [".md", "text/markdown"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".txt", "text/plain"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
]);

export function registerAttachmentCommand(program: Command, deps: RegisterAttachmentCommandDeps): void {
  const attachmentCmd = program.command("attachment").description("Publish local files as chat attachments");

  attachmentCmd
    .command("publish <path>")
    .description("Copy a local file into aimux attachments and print a transcript reference")
    .requiredOption("--session <sessionId>", "Session that owns the attachment")
    .option("--project <path>", "Project path")
    .option("--name <filename>", "Display filename")
    .option("--mime <mimeType>", "Attachment MIME type")
    .option("--json", "Emit JSON")
    .action(
      async (
        filePath: string,
        opts: { session: string; project?: string; name?: string; mime?: string; json?: boolean },
      ) => {
        const sourcePath = pathResolve(filePath);
        const projectRoot = opts.project
          ? await deps.prepareProjectContext(opts.project)
          : await deps.prepareProjectContext();
        let sourceRealPath: string;
        try {
          sourceRealPath = assertPublishableSource({
            sourcePath,
            projectRoot,
            allowedRoots: deps.listWorktrees(projectRoot).map((worktree) => worktree.path),
          });
        } catch (error) {
          console.error(`aimux: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
        const hostPublishedAttachment = deps.hostPublishedAttachment ?? maybeHostPublishedAttachment;
        const hostedAttachment = await hostPublishedAttachment({
          sourcePath: sourceRealPath,
          filename: opts.name || basename(sourcePath),
          mimeType: opts.mime || mimeTypeForPublishedAttachment(sourcePath),
          sessionId: opts.session,
        });
        const result = await deps.postProjectServiceJson(
          PROJECT_API_ROUTES.attachmentsPublish,
          {
            path: sourceRealPath,
            sessionId: opts.session,
            filename: opts.name,
            mimeType: opts.mime,
            ...(hostedAttachment ? { hostedAttachment } : {}),
          },
          { projectRoot },
        );
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.referenceText);
      },
    );
}
