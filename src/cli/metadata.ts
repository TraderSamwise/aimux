import type { Command } from "commander";
import type { AgentActivityState, AgentAttentionState, AgentEventKind } from "../agent-events.js";
import type { MetadataTone, SessionContextMetadata, SessionServiceMetadata } from "../metadata-store.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";

export interface MetadataEndpoint {
  host: string;
  port: number;
}

export interface RegisterMetadataCommandDeps {
  getProjectServiceEndpoint: () => Promise<MetadataEndpoint>;
  postProjectServiceJson: (path: string, body: unknown) => Promise<any>;
}

async function postRuntimeMetadata(deps: RegisterMetadataCommandDeps, path: string, body: unknown): Promise<void> {
  await deps.postProjectServiceJson(path, body);
}

export function serviceMetadataFromUrls(urls: string[], label?: string): SessionServiceMetadata[] {
  return (urls ?? []).map((url) => {
    const match = url.match(/:(\d+)(?:\/|$)/);
    return {
      label,
      url,
      port: match ? Number(match[1]) : undefined,
    };
  });
}

export function registerMetadataCommand(program: Command, deps: RegisterMetadataCommandDeps): void {
  const metadataCmd = program.command("metadata").description("Push metadata into aimux tmux status integration");

  metadataCmd
    .command("endpoint")
    .description("Print the local metadata API endpoint")
    .action(async () => {
      const endpoint = await deps.getProjectServiceEndpoint();
      console.log(`http://${endpoint.host}:${endpoint.port}`);
    });

  metadataCmd
    .command("event <session> <kind>")
    .option("--message <message>", "Event message")
    .option("--source <source>", "Event source")
    .option("--tone <tone>", "Event tone")
    .option("--thread-id <threadId>", "Thread identifier")
    .option("--thread-name <threadName>", "Thread name")
    .description("Emit a normalized agent event")
    .action(
      async (
        session: string,
        kind: AgentEventKind,
        opts: {
          message?: string;
          source?: string;
          tone?: MetadataTone;
          threadId?: string;
          threadName?: string;
        },
      ) => {
        await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.event, {
          session,
          event: {
            kind,
            message: opts.message,
            source: opts.source,
            tone: opts.tone,
            threadId: opts.threadId,
            threadName: opts.threadName,
          },
        });
      },
    );

  metadataCmd
    .command("mark-seen <session>")
    .description("Mark a session's unseen activity as seen")
    .action(async (session: string) => {
      await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.markSeen, { session });
    });

  metadataCmd
    .command("set-activity <session> <activity>")
    .description("Set derived activity state for a session")
    .action(async (session: string, activity: AgentActivityState) => {
      await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.setActivity, { session, activity });
    });

  metadataCmd
    .command("set-attention <session> <attention>")
    .description("Set derived attention state for a session")
    .action(async (session: string, attention: AgentAttentionState) => {
      await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.setAttention, { session, attention });
    });

  metadataCmd
    .command("set-status <session> <text>")
    .option("--tone <tone>", "Status tone", "info")
    .description("Set a session status pill")
    .action(async (session: string, text: string, opts: { tone?: MetadataTone }) => {
      await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.setStatus, { session, text, tone: opts.tone });
    });

  metadataCmd
    .command("set-progress <session> <current> <total>")
    .option("--label <label>", "Progress label")
    .description("Set per-session progress")
    .action(async (session: string, current: string, total: string, opts: { label?: string }) => {
      const currentNum = Number(current);
      const totalNum = Number(total);
      if (!Number.isFinite(currentNum) || !Number.isFinite(totalNum)) {
        console.error("metadata set-progress requires numeric <current> and <total>");
        process.exitCode = 1;
        return;
      }
      await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.setProgress, {
        session,
        current: currentNum,
        total: totalNum,
        label: opts.label,
      });
    });

  metadataCmd
    .command("set-context <session>")
    .option("--cwd <cwd>", "Working directory")
    .option("--worktree-path <path>", "Worktree path")
    .option("--worktree-name <name>", "Worktree name")
    .option("--branch <branch>", "Git branch")
    .option("--pr-number <number>", "PR number")
    .option("--pr-title <title>", "PR title")
    .option("--pr-url <url>", "PR URL")
    .description("Set rich session context metadata")
    .action(
      async (
        session: string,
        opts: {
          cwd?: string;
          worktreePath?: string;
          worktreeName?: string;
          branch?: string;
          prNumber?: string;
          prTitle?: string;
          prUrl?: string;
        },
      ) => {
        const context: SessionContextMetadata = {
          cwd: opts.cwd,
          worktreePath: opts.worktreePath,
          worktreeName: opts.worktreeName,
          branch: opts.branch,
        };
        if (opts.prNumber || opts.prTitle || opts.prUrl) {
          context.pr = {
            number: opts.prNumber ? Number(opts.prNumber) : undefined,
            title: opts.prTitle,
            url: opts.prUrl,
          };
        }
        await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.setContext, { session, context });
      },
    );

  metadataCmd
    .command("set-services <session>")
    .requiredOption("--url <url...>", "One or more service URLs")
    .option("--label <label>", "Shared label for the services")
    .description("Set detected session services/ports")
    .action(async (session: string, opts: { url: string[]; label?: string }) => {
      await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.setServices, {
        session,
        services: serviceMetadataFromUrls(opts.url ?? [], opts.label),
      });
    });

  metadataCmd
    .command("log <session> <message>")
    .option("--source <source>", "Log source")
    .option("--tone <tone>", "Log tone")
    .description("Append a session log line")
    .action(async (session: string, message: string, opts: { source?: string; tone?: MetadataTone }) => {
      await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.log, {
        session,
        message,
        source: opts.source,
        tone: opts.tone,
      });
    });

  metadataCmd
    .command("clear-log <session>")
    .description("Clear session logs")
    .action(async (session: string) => {
      await postRuntimeMetadata(deps, PROJECT_API_ROUTES.runtime.clearLog, { session });
    });
}
