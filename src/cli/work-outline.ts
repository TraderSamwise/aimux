import type { Command } from "commander";
import {
  PROJECT_API_ROUTES,
  type WorkOutlineEntry,
  type WorkOutlineQuery,
  type WorkOutlineStatus,
} from "../project-api-contract.js";

export interface RegisterWorkOutlineCommandDeps {
  prepareProjectContext: (requestedProject?: string) => Promise<string>;
  getProjectServiceJson: (path: string, opts?: { projectRoot?: string }) => Promise<any>;
  postProjectServiceJson: (path: string, body: unknown, opts?: { projectRoot?: string }) => Promise<any>;
}

function outlineQueryPath(query: WorkOutlineQuery & { entryId?: string }): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.sessionId) params.set("sessionId", query.sessionId);
  if (query.worktreePath) params.set("worktreePath", query.worktreePath);
  if (query.status) params.set("status", query.status);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.entryId) params.set("entryId", query.entryId);
  const rendered = params.toString();
  return rendered ? `${PROJECT_API_ROUTES.workOutline.list}?${rendered}` : PROJECT_API_ROUTES.workOutline.list;
}

export function renderWorkOutlineEntries(entries: WorkOutlineEntry[]): string[] {
  if (entries.length === 0) return ["No work outline entries."];
  const lines: string[] = [];
  for (const entry of entries) {
    const sessionText = entry.sessionIds.length > 0 ? ` · ${entry.sessionIds.join(",")}` : "";
    const worktreeText = entry.worktreePath ? ` · ${entry.worktreePath}` : "";
    lines.push(`${entry.entryId} [${entry.status}] ${entry.title}${sessionText}${worktreeText}`);
    lines.push(`  ${entry.summary}`);
  }
  return lines;
}

function parseLimit(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStatus(value?: string): WorkOutlineStatus | undefined {
  return value === "active" || value === "done" || value === "superseded" || value === "stale" ? value : undefined;
}

export function registerWorkOutlineCommand(program: Command, deps: RegisterWorkOutlineCommandDeps): void {
  const outlineCmd = program.command("outline").description("Manage the project work outline");

  outlineCmd
    .command("list")
    .description("List work outline entries")
    .option("--project <path>", "Project path")
    .option("--session <sessionId>", "Filter by Aimux session id")
    .option("--worktree <path>", "Filter by worktree path")
    .option("--status <status>", "Filter by status: active, done, superseded, stale")
    .option("--search <query>", "Search title, summary, topic key, worktree, and sessions")
    .option("--limit <count>", "Maximum entries to print")
    .option("--json", "Emit JSON")
    .action(
      async (opts: {
        project?: string;
        session?: string;
        worktree?: string;
        status?: string;
        search?: string;
        limit?: string;
        json?: boolean;
      }) => {
        const projectRoot = await deps.prepareProjectContext(opts.project);
        const result = await deps.getProjectServiceJson(
          outlineQueryPath({
            q: opts.search,
            sessionId: opts.session,
            worktreePath: opts.worktree,
            status: parseStatus(opts.status),
            limit: parseLimit(opts.limit),
          }),
          { projectRoot },
        );
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, projectRoot, entries: result.entries ?? [] }, null, 2));
          return;
        }
        renderWorkOutlineEntries(result.entries ?? []).forEach((line) => console.log(line));
      },
    );

  outlineCmd
    .command("show <entryId>")
    .description("Show one work outline entry")
    .option("--project <path>", "Project path")
    .option("--json", "Emit JSON")
    .action(async (entryId: string, opts: { project?: string; json?: boolean }) => {
      const projectRoot = await deps.prepareProjectContext(opts.project);
      const result = await deps.getProjectServiceJson(outlineQueryPath({ entryId }), { projectRoot });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, projectRoot, entry: result.entry ?? null }, null, 2));
        return;
      }
      renderWorkOutlineEntries(result.entry ? [result.entry] : []).forEach((line) => console.log(line));
    });

  outlineCmd
    .command("update")
    .description("Create or update a work outline entry")
    .requiredOption("--title <title>", "Entry title")
    .requiredOption("--summary <summary>", "Short entry summary")
    .option("--project <path>", "Project path")
    .option("--topic-key <key>", "Stable topic key for dedupe")
    .option("--session <sessionId>", "Aimux session id")
    .option("--worktree <path>", "Worktree path")
    .option("--status <status>", "Entry status: active, done, superseded, stale")
    .option("--source <source>", "Update source: agent, scribe, system, human")
    .option("--json", "Emit JSON")
    .action(
      async (opts: {
        project?: string;
        title: string;
        summary: string;
        topicKey?: string;
        session?: string;
        worktree?: string;
        status?: string;
        source?: string;
        json?: boolean;
      }) => {
        const projectRoot = await deps.prepareProjectContext(opts.project);
        const result = await deps.postProjectServiceJson(
          PROJECT_API_ROUTES.workOutline.update,
          {
            title: opts.title,
            summary: opts.summary,
            topicKey: opts.topicKey,
            sessionId: opts.session,
            worktreePath: opts.worktree,
            status: opts.status,
            source: opts.source,
          },
          { projectRoot },
        );
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, projectRoot, entry: result.entry }, null, 2));
          return;
        }
        renderWorkOutlineEntries(result.entry ? [result.entry] : []).forEach((line) => console.log(line));
      },
    );
}
