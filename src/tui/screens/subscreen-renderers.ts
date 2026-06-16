import type { GraveyardViewRow } from "../../multiplexer/graveyard-view-model.js";
import { formatRelativeRecency } from "../../recency.js";
import { renderOverlayBox } from "../render/box.js";
import { twoPaneLeftWidth } from "../render/text.js";
import { card, chip, keycapHint, keycapHints, statusDot, style, type Tone } from "../render/theme.js";

// Shared subscreen chrome built from the design-language tokens.
function screenHeader(ctx: any, cols: number, title: string, suffix = ""): string[] {
  const heading = `${style("aimux", "strong")} ${style(`— ${title}`, "muted")}${suffix}`;
  return [
    "",
    ctx.centerInWidth(heading, cols),
    ctx.centerInWidth(style("─".repeat(Math.min(50, cols - 4)), "muted"), cols),
    "",
  ];
}

function rule(ctx: any, cols: number, max: number): string {
  return ctx.centerInWidth(style("─".repeat(Math.min(cols - 4, max)), "muted"), cols);
}

const marker = (selected: boolean): string => (selected ? `${style("▸", "accent")} ` : "  ");
const trailingMark = (selected: boolean): string => (selected ? ` ${style("◀", "accent")}` : "");
const itemNumber = (index: number): string => style(`[${index + 1}]`, "muted");

export function renderWorkflowScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "workflow", ` ${style(`[${ctx.describeWorkflowFilter()}]`, "muted")}`);
  const footer = ctx.centerInWidth(
    keycapHints(
      "[↑↓] select  [f] filter  [Tab] details  [d/a/n/y/t/p/g] screens  [s] reply  [a] accept  [b] block  [c/x] complete  [P] approve  [J] changes  [E] reopen  [Enter] thread  [Esc] dashboard  [q] quit",
    ),
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.workflowEntries.length === 0) {
    listLines.push(`  ${style("Workflow", "strong")}`);
    listLines.push(`    ${style("No open task/review/handoff workflow items.", "muted")}`);
  } else {
    listLines.push(`  ${style("Workflow", "strong")}`);
    for (let i = 0; i < ctx.workflowEntries.length; i++) {
      const entry = ctx.workflowEntries[i]!;
      const selected = i === ctx.workflowIndex;
      const pending = entry.pendingDeliveries > 0 ? ` ${style(`⇢ ${entry.pendingDeliveries}`, "danger")}` : "";
      const unread =
        (entry.thread.unreadBy?.length ?? 0) > 0 ? ` ${style(String(entry.thread.unreadBy!.length), "work")}` : "";
      const family = entry.familyTaskIds.length > 1 ? ` ${style(`⤳${entry.familyTaskIds.length}`, "blocked")}` : "";
      const latest = entry.latestMessage?.body
        ? ` ${style(`· ${ctx.truncatePlain(entry.latestMessage.body, 28)}`, "muted")}`
        : "";
      listLines.push(
        `${marker(selected)}${itemNumber(i)} ${entry.displayTitle} ${style(`(${entry.thread.kind})`, "muted")} ${style("—", "muted")} ${entry.stateLabel}${family}${unread}${pending}${latest}${trailingMark(selected)}`,
      );
    }
  }

  const focusLine = ctx.workflowEntries.length === 0 ? 1 : ctx.workflowIndex + 1;
  const body = ctx.composeSplitScreen(
    listLines,
    renderWorkflowDetails(ctx, Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
    cols,
    viewportHeight,
    focusLine,
    twoPane,
  );
  ctx.writeFrame("\x1b[2J\x1b[H" + [...header, ...body, rule(ctx, cols, 72), footer].join("\r\n"));
}

export function renderWorkflowDetails(ctx: any, width: number, height: number): string[] {
  const entry = ctx.workflowEntries[ctx.workflowIndex];
  if (!entry) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push(style("Workflow", "strong"));
  lines.push(...ctx.wrapKeyValue("Title", entry.displayTitle, width));
  lines.push(...ctx.wrapKeyValue("Kind", entry.thread.kind, width));
  lines.push(...ctx.wrapKeyValue("State", entry.stateLabel, width));
  if (entry.task) {
    lines.push(...ctx.wrapKeyValue("Task Status", entry.task.status, width));
    if (entry.task.type === "review" && entry.task.reviewStatus) {
      lines.push(...ctx.wrapKeyValue("Review", entry.task.reviewStatus, width));
    }
    if (entry.familyTaskIds.length > 1) {
      lines.push(...ctx.wrapKeyValue("Workflow Root", entry.familyRootTaskId ?? entry.task.id, width));
      lines.push(...ctx.wrapKeyValue("Chain Size", String(entry.familyTaskIds.length), width));
      lines.push(...ctx.wrapKeyValue("Chain", entry.familyTaskIds.join(" → "), width));
    }
    lines.push(...ctx.wrapKeyValue("Prompt", entry.task.prompt, width));
    if (entry.task.result) lines.push(...ctx.wrapKeyValue("Result", entry.task.result, width));
    if (entry.task.error) lines.push(...ctx.wrapKeyValue("Error", entry.task.error, width));
  }
  if (entry.thread.owner) lines.push(...ctx.wrapKeyValue("Owner", entry.thread.owner, width));
  if ((entry.thread.waitingOn?.length ?? 0) > 0) {
    lines.push(...ctx.wrapKeyValue("Waiting On", entry.thread.waitingOn!.join(", "), width));
  }
  if (entry.pendingDeliveries > 0) {
    lines.push(...ctx.wrapKeyValue("Pending Delivery", entry.latestPendingRecipients.join(", "), width));
  }
  if (entry.thread.taskId) lines.push(...ctx.wrapKeyValue("Task", entry.thread.taskId, width));
  lines.push("");
  lines.push(style("Latest", "strong"));
  if (entry.latestMessage) {
    lines.push(
      ...ctx.wrapKeyValue(`${entry.latestMessage.from} [${entry.latestMessage.kind}]`, entry.latestMessage.body, width),
    );
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

export function renderActivityScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "activity");
  const footer = ctx.centerInWidth(
    keycapHints(
      "[↑↓] select  [Tab] details  [d/a/n/y/t/p/g] screens  [1-9/Enter] focus  [u] next attention  [Esc] dashboard  [q] quit",
    ),
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.activityEntries.length === 0) {
    listLines.push(`  ${style("Activity", "strong")}`);
    listLines.push(`    ${style("No sessions currently need attention.", "muted")}`);
  } else {
    listLines.push(`  ${style("Activity", "strong")}`);
    for (let i = 0; i < ctx.activityEntries.length; i++) {
      const entry = ctx.activityEntries[i]!;
      const selected = i === ctx.activityIndex;
      const identity = entry.label ?? entry.command;
      const roleTag = entry.role ? ` ${style(`(${entry.role})`, "work")}` : "";
      const wt = entry.worktreeName
        ? ` ${style(`· ${ctx.truncatePlain(entry.worktreeName, 18)}${entry.worktreeBranch ? `@${ctx.truncatePlain(entry.worktreeBranch, 18)}` : ""}`, "muted")}`
        : "";
      const state = entry.semantic?.presentation?.statusLabel ?? entry.status;
      const unread =
        (entry.semantic?.notifications?.unreadCount ?? 0) > 0
          ? ` ${style(String(Math.min(entry.semantic.notifications.unreadCount, 99)), "work")}`
          : "";
      const service = entry.services?.[0]
        ? ` ${style(`· ${entry.services[0].port ? `:${entry.services[0].port}` : ctx.truncatePlain(entry.services[0].url ?? "", 16)}`, "muted")}`
        : "";
      listLines.push(
        `${marker(selected)}${itemNumber(i)} ${identity}${roleTag} ${style("—", "muted")} ${state}${unread}${wt}${service}${trailingMark(selected)}`,
      );
    }
  }

  const focusLine = ctx.activityEntries.length === 0 ? 1 : ctx.activityIndex + 1;
  const body = ctx.composeSplitScreen(
    listLines,
    ctx.renderSessionDetails(
      ctx.activityEntries[ctx.activityIndex],
      Math.max(28, cols - Math.floor(cols * 0.56) - 3),
      viewportHeight,
    ),
    cols,
    viewportHeight,
    focusLine,
    twoPane,
  );
  ctx.writeFrame("\x1b[2J\x1b[H" + [...header, ...body, rule(ctx, cols, 72), footer].join("\r\n"));
}

export function renderThreadsScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "threads");
  const footer = ctx.centerInWidth(
    keycapHints(
      "[↑↓] select  [Tab] details  [d/a/n/y/t/p/g] screens  [s] reply  [a] accept  [c] complete  [b/o/x] state  [Enter] jump  [r] refresh  [Esc] dashboard  [q] quit",
    ),
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.threadEntries.length === 0) {
    listLines.push(`  ${style("Threads", "strong")}`);
    listLines.push(`    ${style("No orchestration threads yet.", "muted")}`);
  } else {
    listLines.push(`  ${style("Threads", "strong")}`);
    for (let i = 0; i < ctx.threadEntries.length; i++) {
      const entry = ctx.threadEntries[i]!;
      const selected = i === ctx.threadIndex;
      const unread =
        (entry.thread.unreadBy?.length ?? 0) > 0 ? ` ${style(String(entry.thread.unreadBy!.length), "work")}` : "";
      const waiting =
        (entry.thread.waitingOn?.length ?? 0) > 0
          ? ` ${style(`→ ${entry.thread.waitingOn!.join(",")}`, "blocked")}`
          : "";
      const pending = entry.pendingDeliveries > 0 ? ` ${style(`⇢ ${entry.pendingDeliveries}`, "danger")}` : "";
      const latest = entry.latestMessage?.body
        ? ` ${style(`· ${ctx.truncatePlain(entry.latestMessage.body, 34)}`, "muted")}`
        : "";
      listLines.push(
        `${marker(selected)}${itemNumber(i)} ${entry.displayTitle} ${style(`(${entry.thread.kind})`, "muted")} ${style("—", "muted")} ${entry.thread.status}${unread}${waiting}${pending}${latest}${trailingMark(selected)}`,
      );
    }
  }

  const focusLine = ctx.threadEntries.length === 0 ? 1 : ctx.threadIndex + 1;
  const body = ctx.composeSplitScreen(
    listLines,
    renderThreadDetails(ctx, Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
    cols,
    viewportHeight,
    focusLine,
    twoPane,
  );
  ctx.writeFrame("\x1b[2J\x1b[H" + [...header, ...body, rule(ctx, cols, 72), footer].join("\r\n"));
}

export function renderThreadDetails(ctx: any, width: number, height: number): string[] {
  const entry = ctx.threadEntries[ctx.threadIndex];
  if (!entry) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push(style("Details", "strong"));
  lines.push(...ctx.wrapKeyValue("Title", entry.displayTitle, width));
  lines.push(...ctx.wrapKeyValue("Kind", entry.thread.kind, width));
  lines.push(...ctx.wrapKeyValue("Status", entry.thread.status, width));
  lines.push(...ctx.wrapKeyValue("Created By", entry.thread.createdBy, width));
  lines.push(...ctx.wrapKeyValue("Participants", entry.thread.participants.join(", "), width));
  if (entry.thread.owner) lines.push(...ctx.wrapKeyValue("Owner", entry.thread.owner, width));
  if (entry.thread.kind === "handoff") {
    lines.push(...ctx.wrapKeyValue("Handoff", ctx.describeHandoffState(entry.thread), width));
  }
  if ((entry.thread.waitingOn?.length ?? 0) > 0) {
    lines.push(...ctx.wrapKeyValue("Waiting On", entry.thread.waitingOn!.join(", "), width));
  }
  if ((entry.thread.unreadBy?.length ?? 0) > 0) {
    lines.push(...ctx.wrapKeyValue("Unread By", entry.thread.unreadBy!.join(", "), width));
  }
  if (entry.pendingDeliveries > 0) {
    lines.push(...ctx.wrapKeyValue("Pending Delivery", entry.latestPendingRecipients.join(", "), width));
  }
  if (entry.thread.taskId) lines.push(...ctx.wrapKeyValue("Task", entry.thread.taskId, width));
  if (entry.thread.worktreePath) lines.push(...ctx.wrapKeyValue("Worktree", entry.thread.worktreePath, width));
  lines.push("");
  lines.push(style("Messages", "strong"));
  const messages = (entry.messages ?? []).slice(-Math.max(3, height - lines.length));
  for (const message of messages) {
    const prefix = `${message.from}${message.to?.length ? ` → ${message.to.join(", ")}` : ""} [${message.kind}]`;
    const delivered = message.deliveredTo ?? [];
    const pending = (message.to ?? []).filter((recipient: string) => !(message.deliveredTo ?? []).includes(recipient));
    const statusParts: string[] = [];
    if (delivered.length > 0) {
      statusParts.push(
        pending.length > 0 ? `delivered ${delivered.join(", ")}` : `delivered to ${delivered.join(", ")}`,
      );
    }
    if (pending.length > 0) {
      statusParts.push(`pending ${pending.join(", ")}`);
    }
    const suffix = statusParts.length > 0 ? ` (${statusParts.join("; ")})` : "";
    lines.push(...ctx.wrapKeyValue(prefix, `${message.body}${suffix}`, width));
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

export function renderNotificationsScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "inbox");
  const footer = ctx.centerInWidth(
    keycapHints(
      "[↑↓] select  [Tab] details  [d/a/i/y/t/p/g] screens  [Enter] jump  [r] read  [R] read all  [c] clear  [C] clear all  [Esc] dashboard  [q] quit",
    ),
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.notificationEntries.length === 0) {
    listLines.push(`  ${style("Inbox", "strong")}`);
    listLines.push(`    ${style("No unread or recent inbox items.", "muted")}`);
  } else {
    listLines.push(`  ${style("Inbox", "strong")}`);
    for (let i = 0; i < ctx.notificationEntries.length; i++) {
      const entry = ctx.notificationEntries[i]!;
      const selected = i === ctx.notificationIndex;
      const dot = entry.unread ? statusDot("needs") : statusDot("offline");
      const target = entry.sessionId ? ctx.notificationTargetLabel(entry.sessionId) : null;
      const targetState = entry.sessionId ? ctx.notificationTargetState(entry.sessionId) : "none";
      const targetStateLabel =
        targetState === "live"
          ? style("live", "done")
          : targetState === "offline"
            ? style("offline", "attn")
            : targetState === "missing"
              ? style("missing", "danger")
              : "";
      const targetHint = target ? ` ${style(`· ${ctx.truncatePlain(target, 24)}`, "muted")}` : "";
      const kind = entry.kind ? ` ${style(`(${entry.kind})`, "muted")}` : "";
      const when = ` ${style(`· ${formatRelativeRecency(entry.createdAt)}`, "muted")}`;
      const titleTone = entry.unread ? "strong" : "muted";
      listLines.push(
        `${marker(selected)}${itemNumber(i)} ${dot} ${style(ctx.truncatePlain(entry.title, 44), titleTone)}${kind}${targetStateLabel ? ` ${style("·", "muted")} ${targetStateLabel}` : ""}${targetHint}${when}${trailingMark(selected)}`,
      );
    }
  }

  const focusLine = ctx.notificationEntries.length === 0 ? 1 : ctx.notificationIndex + 1;
  const body = ctx.composeSplitScreen(
    listLines,
    renderNotificationDetails(ctx, Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
    cols,
    viewportHeight,
    focusLine,
    twoPane,
  );
  ctx.writeFrame("\x1b[2J\x1b[H" + [...header, ...body, rule(ctx, cols, 72), footer].join("\r\n"));
}

export function renderNotificationDetails(ctx: any, width: number, height: number): string[] {
  const entry = ctx.notificationEntries[ctx.notificationIndex];
  if (!entry) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push(style("Details", "strong"));
  lines.push(...ctx.wrapKeyValue("Title", entry.title, width));
  if (entry.subtitle) lines.push(...ctx.wrapKeyValue("Subtitle", entry.subtitle, width));
  lines.push(...ctx.wrapKeyValue("State", entry.unread ? "unread" : "read", width));
  lines.push(...ctx.wrapKeyValue("Created", entry.createdAt, width));
  if (entry.kind) lines.push(...ctx.wrapKeyValue("Kind", entry.kind, width));
  if (entry.sessionId) {
    lines.push(...ctx.wrapKeyValue("Session", entry.sessionId, width));
    lines.push(...ctx.wrapKeyValue("Target State", ctx.notificationTargetState(entry.sessionId), width));
    const targetLabel = ctx.notificationTargetLabel(entry.sessionId);
    if (targetLabel) lines.push(...ctx.wrapKeyValue("Target", targetLabel, width));
  }
  lines.push("");
  lines.push(style("Body", "strong"));
  lines.push(...ctx.wrapKeyValue("", entry.body, width));
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

interface GraveyardCardRow {
  text: string;
  actionIndex?: number;
}
interface GraveyardCardBlock {
  kind: "card";
  title: string;
  summary?: string;
  titleActionIndex?: number;
  rows: GraveyardCardRow[];
}
type GraveyardLooseBlock = { kind: "loose"; rows: GraveyardCardRow[] };
type GraveyardBlock = GraveyardCardBlock | GraveyardLooseBlock | { kind: "header"; label: string };

// Group the flat graveyard view-model rows into design-language blocks: a card per
// graveyarded worktree (dead agents/services as body rows) and per standalone-agent
// worktree group; loose selectable rows for orphan agents/teammates that have no
// group. Everything is dead, so cards render in the muted tone.
function buildGraveyardCards(ctx: any, rows: GraveyardViewRow[]): GraveyardBlock[] {
  const blocks: GraveyardBlock[] = [];
  let current: GraveyardCardBlock | GraveyardLooseBlock | null = null;

  const flush = (): void => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };
  const ensureCard = (): GraveyardCardBlock => {
    if (!current || current.kind !== "card") {
      flush();
      current = { kind: "card", title: "", rows: [] };
    }
    return current;
  };
  const ensureLoose = (): GraveyardLooseBlock => {
    if (!current || current.kind !== "loose") {
      flush();
      current = { kind: "loose", rows: [] };
    }
    return current;
  };
  const recencyChip = (at?: string): string => {
    const rel = at ? formatRelativeRecency(at) : undefined;
    return rel ? chip(rel, "muted") : "";
  };
  const withChip = (text: string, chipStr: string): string => (chipStr ? `${text} ${chipStr}` : text);

  for (const row of rows) {
    switch (row.kind) {
      case "section":
        flush();
        blocks.push({ kind: "header", label: row.label });
        break;
      case "worktree": {
        flush();
        const selected = row.actionIndex === ctx.graveyardIndex;
        const branch = row.entry.branch ? ` ${style(`· ${row.entry.branch}`, "muted")}` : "";
        const nameTone: Tone = selected ? "accent" : "strong";
        const title = `${marker(selected)}${keycapHint(String(row.actionNumber))} ${style(row.entry.name, nameTone)}${branch}`;
        const serviceCount = row.attachedServices.length;
        const serviceText = serviceCount > 0 ? ` · ${serviceCount} svc${serviceCount === 1 ? "" : "s"}` : "";
        const agentCount = row.attachedAgents.length;
        const countText = style(`${agentCount} agent${agentCount === 1 ? "" : "s"}${serviceText}`, "muted");
        current = {
          kind: "card",
          title,
          summary: withChip(countText, recencyChip(row.lastUsedAt)),
          titleActionIndex: row.actionIndex,
          rows: [],
        };
        break;
      }
      case "attached-agent-display": {
        const agent = row.agent.entry;
        const bsid = agent.backendSessionId ? ` (${agent.backendSessionId.slice(0, 8)}…)` : "";
        const identity = agent.label ? ` — ${agent.label}` : "";
        const headline = agent.headline ? ` · ${agent.headline}` : "";
        const text = `  ${statusDot("offline")} ${style(`${agent.command}:${agent.id}${bsid}${identity}${headline}`, "muted")}`;
        ensureCard().rows.push({ text: withChip(text, recencyChip(row.agent.lastUsedAt)) });
        break;
      }
      case "attached-more-display":
        ensureCard().rows.push({
          text: `  ${style(`… ${row.hiddenAgentCount} more agent${row.hiddenAgentCount === 1 ? "" : "s"}`, "muted")}`,
        });
        break;
      case "attached-service-display": {
        const service = row.service.entry;
        const identity = service.label ?? service.launchCommandLine ?? "shell";
        const text = `  ${statusDot("serviceOff")} ${style(`${identity} [service]`, "muted")}`;
        ensureCard().rows.push({ text: withChip(text, recencyChip(row.service.lastUsedAt)) });
        break;
      }
      case "agent-worktree":
        flush();
        current = { kind: "card", title: style(row.name, "strong"), rows: [] };
        break;
      case "orphan-teammate": {
        const teammate = row.entry;
        const identity = teammate.label ? ` — ${teammate.label}` : "";
        const headline = teammate.headline ? ` · ${ctx.truncatePlain(teammate.headline, 36)}` : "";
        const text = `  ${statusDot("offline")} ${style(`${teammate.command}:${teammate.id}${identity} · missing parent ${row.parentSessionId}${headline}`, "muted")}`;
        ensureLoose().rows.push({ text: withChip(text, recencyChip(row.lastUsedAt)) });
        break;
      }
      default: {
        const agent = row.entry;
        const selected = row.actionIndex === ctx.graveyardIndex;
        const bsid = agent.backendSessionId ? ` (${agent.backendSessionId.slice(0, 8)}…)` : "";
        const identity = agent.label ? ` — ${agent.label}` : "";
        const headline = agent.headline ? ` · ${agent.headline}` : "";
        const unrecoverable = agent.graveyardReason ? ` ${style("· unrecoverable", "danger")}` : "";
        const text = `${marker(selected)}${keycapHint(String(row.actionNumber))} ${statusDot("offline")} ${style(`${agent.command}:${agent.id}${bsid}${identity}${headline}`, "muted")}${unrecoverable}`;
        // Standalone agents under an "agent-worktree" land in its card; orphan agents
        // with no group render as loose selectable rows beneath the section header.
        const target = current && current.kind === "card" ? current : ensureLoose();
        target.rows.push({ text: withChip(text, recencyChip(row.lastUsedAt)), actionIndex: row.actionIndex });
        break;
      }
    }
  }
  flush();
  return blocks;
}

export function renderGraveyardScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "graveyard");
  const footer = ctx.centerInWidth(
    keycapHints(
      "[↑↓] select  [Tab] details  [d/a/n/y/t/p/g] screens  [1-9/Enter] resurrect  [x] delete worktree  [Esc] dashboard  [q] quit",
    ),
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const cardWidth = twoPane ? twoPaneLeftWidth(cols) : Math.max(40, cols - 2);
  const listLines: string[] = [];
  const lineByItemIndex = new Map<number, number>();
  const view = ctx.graveyardViewModel ?? { rows: [], selectableRows: [] };
  if (view.rows.length === 0) {
    listLines.push(`  ${style("Worktrees", "strong")}`);
    listLines.push(`    ${style("(empty)", "muted")}`);
    listLines.push("");
    listLines.push(`  ${style("Agents", "strong")}`);
    listLines.push(`    ${style("(empty)", "muted")}`);
  } else {
    const blocks = buildGraveyardCards(ctx, view.rows);
    let first = true;
    for (const block of blocks) {
      if (!first) listLines.push("");
      first = false;
      if (block.kind === "header") {
        listLines.push(`  ${style(block.label, "strong")}`);
        continue;
      }
      if (block.kind === "loose") {
        for (const looseRow of block.rows) {
          if (looseRow.actionIndex !== undefined) lineByItemIndex.set(looseRow.actionIndex, listLines.length);
          listLines.push(`  ${looseRow.text}`);
        }
        continue;
      }
      const startLine = listLines.length;
      if (block.titleActionIndex !== undefined) lineByItemIndex.set(block.titleActionIndex, startLine);
      block.rows.forEach((bodyRow, i) => {
        if (bodyRow.actionIndex !== undefined) lineByItemIndex.set(bodyRow.actionIndex, startLine + 1 + i);
      });
      for (const line of card({
        tone: "muted",
        title: block.title,
        summary: block.summary,
        rows: block.rows.map((bodyRow) => bodyRow.text),
        width: cardWidth,
      })) {
        listLines.push(line);
      }
    }
  }
  const focusLine = lineByItemIndex.get(ctx.graveyardIndex) ?? 1;
  const body = ctx.composeSplitScreen(
    listLines,
    renderGraveyardDetails(ctx, Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
    cols,
    viewportHeight,
    focusLine,
    twoPane,
  );
  let frame = "\x1b[2J\x1b[H" + [...header, ...body, rule(ctx, cols, 52), footer].join("\r\n");
  if (ctx.graveyardWorktreeDeleteConfirm) {
    frame += buildGraveyardWorktreeDeleteConfirmOverlay(ctx, cols, rows);
  }
  ctx.writeFrame(frame);
}

export function renderGraveyardDetails(ctx: any, width: number, height: number): string[] {
  const selected = ctx.graveyardViewModel?.selectableRows?.[ctx.graveyardIndex];
  if (!selected) return new Array(height).fill("");
  if (selected.kind === "worktree") {
    const lines: string[] = [];
    lines.push(style("Details", "strong"));
    lines.push(...ctx.wrapKeyValue("Worktree", selected.entry.name, width));
    lines.push(...ctx.wrapKeyValue("Branch", selected.entry.branch, width));
    lines.push(...ctx.wrapKeyValue("Path", selected.entry.path, width));
    lines.push(...ctx.wrapKeyValue("Status", "graveyard", width));
    lines.push(...ctx.wrapKeyValue("Agents", String(selected.attachedAgents.length), width));
    lines.push(...ctx.wrapKeyValue("Services", String(selected.attachedServices.length), width));
    if (selected.lastUsedAt)
      lines.push(...ctx.wrapKeyValue("Last Used", formatRelativeRecency(selected.lastUsedAt), width));
    lines.push("");
    lines.push(style("Attached Agents", "strong"));
    if (selected.attachedAgents.length === 0) {
      lines.push(style("(none)", "muted"));
    } else {
      for (const agent of selected.visibleAttachedAgents.slice(0, Math.max(1, height - lines.length))) {
        const recency = agent.lastUsedAt ? ` · ${formatRelativeRecency(agent.lastUsedAt)}` : "";
        lines.push(`- ${agent.entry.label ?? agent.entry.id}${recency}`);
      }
      if (selected.hiddenAttachedAgentCount > 0 && lines.length < height) {
        lines.push(
          `… ${selected.hiddenAttachedAgentCount} more agent${selected.hiddenAttachedAgentCount === 1 ? "" : "s"}`,
        );
      }
    }
    if (selected.attachedServices.length > 0 && lines.length < height) {
      lines.push("");
      lines.push(style("Attached Services", "strong"));
      for (const service of selected.attachedServices.slice(0, Math.max(1, height - lines.length))) {
        const label = service.entry.label ?? service.entry.launchCommandLine ?? service.entry.id;
        const recency = service.lastUsedAt ? ` · ${formatRelativeRecency(service.lastUsedAt)}` : "";
        lines.push(`- ${label}${recency}`);
      }
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }
  const lines: string[] = [];
  const worktreeName = selected.entry.worktreePath ? ctx.basename(selected.entry.worktreePath) : undefined;
  lines.push(style("Details", "strong"));
  lines.push(...ctx.wrapKeyValue("Agent", selected.entry.label ?? selected.entry.id, width));
  lines.push(...ctx.wrapKeyValue("Session", selected.entry.id, width));
  lines.push(...ctx.wrapKeyValue("Tool", selected.entry.tool, width));
  lines.push(...ctx.wrapKeyValue("Config", selected.entry.toolConfigKey, width));
  lines.push(...ctx.wrapKeyValue("Status", "offline", width));
  if (selected.lastUsedAt)
    lines.push(...ctx.wrapKeyValue("Last Used", formatRelativeRecency(selected.lastUsedAt), width));
  if (worktreeName) lines.push(...ctx.wrapKeyValue("Worktree", worktreeName, width));
  if (selected.entry.worktreePath) lines.push(...ctx.wrapKeyValue("Path", selected.entry.worktreePath, width));
  if (selected.entry.backendSessionId)
    lines.push(...ctx.wrapKeyValue("Backend", selected.entry.backendSessionId, width));
  if (selected.entry.headline) lines.push(...ctx.wrapKeyValue("Headline", selected.entry.headline, width));
  if (selected.entry.graveyardReason)
    lines.push(...ctx.wrapKeyValue("Unrecoverable", selected.entry.graveyardReason, width));
  if (selected.entry.command) lines.push(...ctx.wrapKeyValue("Command", selected.entry.command, width));
  if (selected.entry.args?.length) lines.push(...ctx.wrapKeyValue("Args", selected.entry.args.join(" "), width));
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

function buildGraveyardWorktreeDeleteConfirmOverlay(ctx: any, cols: number, rows: number): string {
  const confirm = ctx.graveyardWorktreeDeleteConfirm;
  if (!confirm) return "";
  const body = [
    `  ${style(`"${confirm.name}"`, "strong")}`,
    `  ${style("Path:", "muted")} ${confirm.path}`,
    `  ${style("This runs: git worktree remove --force", "muted")}`,
    `  ${style("Attached agents will be deleted directly.", "muted")}`,
    "",
    `  ${keycapHint("Enter/y", "yes")}  ${keycapHint("n/Esc", "cancel")}`,
  ];
  return renderOverlayBox({ title: "Delete graveyarded worktree", body, cols, rows, variant: "red" });
}

function buildPlanPreview(ctx: any, content: string, width: number, maxLines: number): string[] {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const rawLines = body.length > 0 ? body.split(/\r?\n/) : ["(empty)"];
  const preview: string[] = [];
  for (const line of rawLines) {
    if (preview.length >= maxLines) break;
    const normalized = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
    preview.push(normalized);
  }
  return preview;
}

export function renderPlansScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "plans");
  const footer = ctx.centerInWidth(
    keycapHints(
      "[↑↓] select  [Tab] details  [d/a/n/y/t/p/g] screens  [e/Enter] edit  [r] refresh  [Esc] dashboard  [q] quit",
    ),
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.planEntries.length === 0) {
    listLines.push(`  ${style("No plan files found in .aimux/plans/", "muted")}`);
  } else {
    listLines.push(`  ${style("Plans", "strong")}`);
    for (let i = 0; i < ctx.planEntries.length; i++) {
      const plan = ctx.planEntries[i];
      const selected = i === ctx.planIndex;
      const identity = plan.label ?? plan.tool ?? "unknown";
      const worktree = plan.worktree ?? "main";
      const updated = plan.updatedAt ? ` · ${plan.updatedAt.replace("T", " ").slice(0, 16)}` : "";
      listLines.push(
        `${marker(selected)}${itemNumber(i)} ${style(identity, "strong")} ${style(`(${plan.sessionId}) · ${worktree}${updated}`, "muted")}`,
      );
    }
  }
  const focusLine = ctx.planEntries.length === 0 ? 0 : ctx.planIndex + 1;
  const body = ctx.composeSplitScreen(
    listLines,
    renderPlanDetails(ctx, Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
    cols,
    viewportHeight,
    focusLine,
    twoPane,
  );
  ctx.writeFrame("\x1b[2J\x1b[H" + [...header, ...body, rule(ctx, cols, 56), footer].join("\r\n"));
}

export function renderPlanDetails(ctx: any, width: number, height: number): string[] {
  const selectedPlan = ctx.planEntries[ctx.planIndex];
  if (!selectedPlan) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push(style("Details", "strong"));
  lines.push(
    ...ctx.wrapKeyValue(
      "Agent",
      `${selectedPlan.label ?? selectedPlan.tool ?? "unknown"} (${selectedPlan.sessionId})`,
      width,
    ),
  );
  lines.push(...ctx.wrapKeyValue("Tool", selectedPlan.tool ?? "unknown", width));
  lines.push(...ctx.wrapKeyValue("Worktree", selectedPlan.worktree ?? "main", width));
  if (selectedPlan.updatedAt) lines.push(...ctx.wrapKeyValue("Updated", selectedPlan.updatedAt, width));
  lines.push(...ctx.wrapKeyValue("File", `.aimux/plans/${selectedPlan.sessionId}.md`, width));
  lines.push("");
  lines.push(style("Preview", "strong"));
  for (const previewLine of buildPlanPreview(ctx, selectedPlan.content, width, Math.max(4, height - lines.length))) {
    lines.push(previewLine);
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}
