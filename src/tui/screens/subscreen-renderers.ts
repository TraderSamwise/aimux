import { isDevelopmentRuntime } from "../../connection-targets.js";
import type { GraveyardViewRow } from "../../multiplexer/graveyard-view-model.js";
import { formatRelativeRecency } from "../../recency.js";
import { AIMUX_VERSION } from "../../version.js";
import { renderOverlayBox } from "../render/box.js";
import { composeScreenFrame } from "../render/screen-frame.js";
import { twoPaneLeftWidth } from "../render/text.js";
import { card, chip, footerHints, keycapHint, statusDot, style, type ChipTone, type Tone } from "../render/theme.js";

// Shared subscreen chrome — identical to the dashboard header (version tag, runtime dot, dev
// badge, full-width rule) so every screen's top section is uniform; only the descriptor changes.
function screenHeader(ctx: any, cols: number, title: string): string[] {
  const dev = isDevelopmentRuntime();
  const devBadge = dev ? "\x1b[1;30;43m DEV \x1b[0m " : "";
  const versionTag = AIMUX_VERSION ? `${style(`v${AIMUX_VERSION}`, "muted")} ` : "";
  const heading = `${devBadge}${style("aimux", "strong")} ${versionTag}— ${title}  ${style("● tmux", "done")}`;
  const divider = dev ? `\x1b[33m${"─".repeat(Math.max(0, cols))}\x1b[0m` : "─".repeat(Math.max(0, cols));
  return ["", ctx.centerInWidth(heading, cols), divider, ""];
}

const marker = (selected: boolean): string => (selected ? `${style("▸", "accent")} ` : "  ");
const trailingMark = (selected: boolean): string => (selected ? ` ${style("◀", "accent")}` : "");
const itemNumber = (index: number): string => style(`[${index + 1}]`, "muted");

const WORKLIST_TYPE_TONE: Record<string, ChipTone> = {
  msg: "work",
  note: "muted",
  task: "info",
  review: "info",
  handoff: "attn",
  conversation: "muted",
};
const WORKLIST_BUCKET_LABEL: Record<string, string> = {
  awake: "Awake · act now",
  asleep: "Asleep · wake to act",
  handled: "Handled",
  unreachable: "Unreachable",
};
const WORKLIST_BUCKET_TONE: Record<string, Tone> = {
  awake: "done",
  asleep: "sleep",
  handled: "muted",
  unreachable: "muted",
};

// Reachability-encoding dot: ● awake (green) · ◐ asleep (slate) · ○ gone (red); threads/notes
// fall back to the actionable/idle dot since they have no agent process to reach.
function reachabilityDot(item: any): string {
  if (item.kind === "notification") {
    if (item.reachability === "live") return style("●", "done");
    if (item.reachability === "offline") return style("◐", "sleep");
    if (item.reachability === "missing") return style("○", "danger");
  }
  return item.actionable ? statusDot("needs") : statusDot("offline");
}

// Trailing reachability/state tags for a worklist row (reuse the inbox + thread vocabularies).
function worklistTags(item: any): string {
  const parts: string[] = [];
  if (item.kind === "notification") {
    if (item.reachability === "live") parts.push(style("live", "done"));
    else if (item.reachability === "offline") parts.push(style("asleep", "sleep"));
    else if (item.reachability === "missing") parts.push(style("gone", "danger"));
    if (item.stale) parts.push(style("stale", "muted"));
  } else if (item.thread) {
    const thread = item.thread.thread;
    if ((thread.waitingOn?.length ?? 0) > 0) parts.push(style(`→ ${thread.waitingOn.join(",")}`, "blocked"));
    if (item.thread.pendingDeliveries > 0) parts.push(style(`⇢ ${item.thread.pendingDeliveries}`, "danger"));
    parts.push(style(item.thread.stateLabel ?? thread.status, "muted"));
  }
  return parts.length ? ` ${style("·", "muted")} ${parts.join(` ${style("·", "muted")} `)}` : "";
}

// Titled bucket rule (dashboard-style): "Awake · act now ──── N", tinted by bucket urgency.
function bucketRule(bucket: string, count: number): string {
  const label = WORKLIST_BUCKET_LABEL[bucket] ?? bucket;
  const tone: Tone = WORKLIST_BUCKET_TONE[bucket] ?? "muted";
  const dashes = Math.max(2, 46 - label.length - String(count).length - 4);
  return `  ${style(label, tone)} ${style("─".repeat(dashes), "muted")} ${style(String(count), tone)}`;
}

// Footer hints contextual to the selected row's kind — and, for asleep agents, honest that
// Enter wakes (a slow resume) rather than opens instantly.
function coordinationFooterHints(item: any, filterThreads: boolean): string {
  const tail = "[d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit";
  const filterHint = `[Tab] ${filterThreads ? "all" : "threads"}`;
  if (item?.kind === "thread") {
    return `[↑↓] select  ${filterHint}  [Enter] jump  [s] reply  [A] accept  [c] complete  [b/o/x] state  [P/J/E] review  ${tail}`;
  }
  const enterVerb =
    item?.reachability === "offline" ? "[Enter] wake" : item?.reachability === "missing" ? "" : "[Enter] open";
  const enter = enterVerb ? `  ${enterVerb}` : "";
  return `[↑↓] select  ${filterHint}${enter}  [r] read  [c] clear  [R] read all  [C] clear all  ${tail}`;
}

export function renderCoordinationScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "coordination");
  const filterThreads = ctx.coordinationFilter === "threads";
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const items = ctx.coordinationWorklist ?? [];
  const selectedItem = items[ctx.coordinationIndex];

  const listLines: string[] = [];
  let focusLine = 1;

  const needYou = items.filter((item: any) => item.bucket === "awake" || item.bucket === "asleep").length;
  const bucketCounts: Record<string, number> = {};
  for (const item of items) bucketCounts[item.bucket] = (bucketCounts[item.bucket] ?? 0) + 1;

  listLines.push(
    `  ${style("Coordination", "strong")} ${style(`(${needYou} need you · ${items.length})`, "muted")}${filterThreads ? ` ${style("· threads", "muted")}` : ""}`,
  );
  if (items.length === 0) {
    listLines.push("");
    listLines.push(`    ${style(filterThreads ? "No threads." : "Nothing needs you.", "muted")}`);
  } else {
    let lastBucket = "";
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.bucket !== lastBucket) {
        listLines.push(""); // breathing room between groups (and below the header)
        listLines.push(bucketRule(item.bucket, bucketCounts[item.bucket] ?? 0));
        lastBucket = item.bucket;
      }
      const selected = i === ctx.coordinationIndex;
      if (selected) focusLine = listLines.length + 1;
      const dot = reachabilityDot(item);
      const typeChip = chip(item.type, WORKLIST_TYPE_TONE[item.type] ?? "muted");
      const titleTone = item.actionable ? "strong" : "muted";
      const when = item.when ? ` ${style(`· ${formatRelativeRecency(item.when)}`, "muted")}` : "";
      listLines.push(
        `${marker(selected)}${itemNumber(i)} ${dot} ${typeChip} ${style(ctx.truncatePlain(item.title, 36), titleTone)}${worklistTags(item)}${when}${trailingMark(selected)}`,
      );
    }
  }

  ctx.writeFrame(
    composeScreenFrame({
      cols,
      rows,
      header,
      content: listLines,
      footerLines: [footerHints(coordinationFooterHints(selectedItem, filterThreads))],
      focusLine,
      twoPane,
      rightPanel: (width, height) => renderCoordinationDetails(ctx, width, height),
    }).frame,
  );
}

export function renderCoordinationDetails(ctx: any, width: number, height: number): string[] {
  const item = (ctx.coordinationWorklist ?? [])[ctx.coordinationIndex];
  if (!item) return new Array(height).fill("");
  return item.kind === "thread"
    ? renderCoordinationThreadDetails(ctx, width, height, item.thread)
    : renderCoordinationNotificationDetails(ctx, width, height, item.notification);
}

function padDetail(lines: string[], height: number): string[] {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

function renderCoordinationNotificationDetails(ctx: any, width: number, height: number, note: any): string[] {
  if (!note) return new Array(height).fill("");
  const inner = Math.max(8, width - 4);
  const latest = note.latestUnread ?? note.notifications[note.notifications.length - 1];
  const rows: string[] = [];
  rows.push(...ctx.wrapKeyValue("Title", note.title, inner));
  rows.push(...ctx.wrapKeyValue("State", note.unreadCount > 0 ? `${note.unreadCount} unread` : "read", inner));
  if (note.sessionId) {
    rows.push(...ctx.wrapKeyValue("Reach", note.reachability, inner));
    rows.push(...ctx.wrapKeyValue("Session", note.sessionId, inner));
    const targetLabel = ctx.notificationTargetLabel(note.sessionId);
    if (targetLabel) rows.push(...ctx.wrapKeyValue("Target", targetLabel, inner));
  }
  if (latest?.kind) rows.push(...ctx.wrapKeyValue("Kind", latest.kind, inner));
  if (latest?.createdAt) rows.push(...ctx.wrapKeyValue("Created", latest.createdAt, inner));
  const bodyRows = latest?.body ? ctx.wrapKeyValue("", latest.body, inner) : [];
  return padDetail(
    [
      ...card({ tone: "muted", title: style("Inbox", "strong"), rows, width }),
      "",
      ...card({ tone: "muted", title: style("Body", "strong"), rows: bodyRows, width }),
    ],
    height,
  );
}

function renderCoordinationThreadDetails(ctx: any, width: number, height: number, entry: any): string[] {
  if (!entry) return new Array(height).fill("");
  const inner = Math.max(8, width - 4);
  const rows: string[] = [];
  rows.push(...ctx.wrapKeyValue("Title", entry.displayTitle, inner));
  rows.push(...ctx.wrapKeyValue("Kind", entry.thread.kind, inner));
  rows.push(...ctx.wrapKeyValue("Status", entry.stateLabel ?? entry.thread.status, inner));
  rows.push(...ctx.wrapKeyValue("Participants", entry.thread.participants.join(", "), inner));
  if (entry.thread.owner) rows.push(...ctx.wrapKeyValue("Owner", entry.thread.owner, inner));
  if (entry.thread.kind === "handoff") {
    rows.push(...ctx.wrapKeyValue("Handoff", ctx.describeHandoffState(entry.thread), inner));
  }
  if ((entry.thread.waitingOn?.length ?? 0) > 0) {
    rows.push(...ctx.wrapKeyValue("Waiting On", entry.thread.waitingOn.join(", "), inner));
  }
  if (entry.task) {
    rows.push(...ctx.wrapKeyValue("Task", entry.task.status, inner));
    if (entry.task.type === "review" && entry.task.reviewStatus) {
      rows.push(...ctx.wrapKeyValue("Review", entry.task.reviewStatus, inner));
    }
    if ((entry.familyTaskIds?.length ?? 0) > 1) {
      rows.push(...ctx.wrapKeyValue("Chain", entry.familyTaskIds.join(" → "), inner));
    }
    if (entry.task.prompt) rows.push(...ctx.wrapKeyValue("Prompt", entry.task.prompt, inner));
    if (entry.task.result) rows.push(...ctx.wrapKeyValue("Result", entry.task.result, inner));
    if (entry.task.error) rows.push(...ctx.wrapKeyValue("Error", entry.task.error, inner));
  }
  if (entry.pendingDeliveries > 0) {
    rows.push(...ctx.wrapKeyValue("Pending", entry.latestPendingRecipients.join(", "), inner));
  }
  const msgRows: string[] = [];
  for (const message of (entry.messages ?? []).slice(-6)) {
    const prefix = `${message.from}${message.to?.length ? ` → ${message.to.join(", ")}` : ""} [${message.kind}]`;
    msgRows.push(...ctx.wrapKeyValue(prefix, message.body, inner));
  }
  return padDetail(
    [
      ...card({ tone: "muted", title: style("Thread", "strong"), rows, width }),
      "",
      ...card({ tone: "muted", title: style("Messages", "strong"), rows: msgRows, width }),
    ],
    height,
  );
}

const STORY_KIND_CHIP: Record<string, ChipTone> = { task: "work", review: "info", notification: "attn" };

export function renderProjectScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "project");
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const obs = ctx.projectObservability ?? { summary: null, progress: null, story: [] };
  const listLines: string[] = [];

  if (!ctx.projectObservabilityLoaded) {
    listLines.push(`  ${style("Loading project...", "muted")}`);
    ctx.writeFrame(
      composeScreenFrame({
        cols,
        rows,
        header,
        content: listLines,
        footerLines: [footerHints("[Tab] details  [r] refresh  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit")],
        focusLine: 1,
        twoPane,
        rightPanel: (_width, height) => new Array(height).fill(""),
      }).frame,
    );
    return;
  }

  if (obs.summary) {
    const s = obs.summary;
    listLines.push(`  ${style("Summary", "strong")}`);
    listLines.push(
      `    ${style(`agents ${s.agentsRunning + s.agentsWaiting + s.agentsOffline}`, "muted")} ${style(`(${s.agentsRunning} run · ${s.agentsWaiting} wait · ${s.agentsOffline} off)`, "muted")}  ${style(`services ${s.services}`, "muted")}  ${style(`worktrees ${s.worktrees}`, "muted")}`,
    );
    listLines.push(
      `    ${style(`tasks ${s.openTasks} open / ${s.doneTasks} done`, "muted")}  ${s.unreadNotifications > 0 ? style(`${s.unreadNotifications} unread`, "attn") : style("0 unread", "muted")}`,
    );
  }
  if (obs.progress) {
    const p = obs.progress;
    listLines.push("");
    listLines.push(`  ${style("Progress", "strong")} ${style(`(${p.total} tasks)`, "muted")}`);
    listLines.push(
      `    ${style(`pending ${p.pending}`, "muted")} · ${style(`assigned ${p.assigned}`, "muted")} · ${style(`active ${p.in_progress}`, "work")} · ${p.blocked > 0 ? style(`blocked ${p.blocked}`, "blocked") : style("blocked 0", "muted")} · ${style(`done ${p.done}`, "done")} · ${p.failed > 0 ? style(`failed ${p.failed}`, "danger") : style("failed 0", "muted")}`,
    );
  }

  listLines.push("");
  listLines.push(`  ${style("Story", "strong")} ${style(`(${obs.story.length})`, "muted")}`);
  let focusLine = listLines.length;
  if (obs.story.length === 0) {
    listLines.push(`    ${style("No recent activity.", "muted")}`);
  } else {
    for (let i = 0; i < obs.story.length; i++) {
      const item = obs.story[i]!;
      const selected = i === ctx.projectIndex;
      if (selected) focusLine = listLines.length + 1;
      const dot = statusDot(item.status === "unread" ? "needs" : "offline");
      const kindChip = chip(item.kind, STORY_KIND_CHIP[item.kind] ?? "muted");
      const titleTone: Tone = item.status === "unread" ? "strong" : "muted";
      const when = ` ${style(`· ${formatRelativeRecency(item.createdAt)}`, "muted")}`;
      const meta = item.meta ? ` ${style(`· ${ctx.truncatePlain(item.meta, 22)}`, "muted")}` : "";
      listLines.push(
        `${marker(selected)}${itemNumber(i)} ${dot} ${kindChip} ${style(ctx.truncatePlain(item.title, 40), titleTone)}${meta}${when}${trailingMark(selected)}`,
      );
    }
  }

  ctx.writeFrame(
    composeScreenFrame({
      cols,
      rows,
      header,
      content: listLines,
      footerLines: [
        footerHints("[↑↓] select  [Tab] details  [r] refresh  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit"),
      ],
      focusLine,
      twoPane,
      rightPanel: (width, height) => renderProjectDetails(ctx, width, height),
    }).frame,
  );
}

export function renderProjectDetails(ctx: any, width: number, height: number): string[] {
  const item = ctx.projectObservability?.story?.[ctx.projectIndex];
  if (!item) return new Array(height).fill("");
  const inner = Math.max(8, width - 4);
  const rows: string[] = [];
  rows.push(...ctx.wrapKeyValue("Title", item.title, inner));
  rows.push(...ctx.wrapKeyValue("Kind", item.kind, inner));
  if (item.status) rows.push(...ctx.wrapKeyValue("Status", item.status, inner));
  if (item.meta) rows.push(...ctx.wrapKeyValue("Meta", item.meta, inner));
  rows.push(...ctx.wrapKeyValue("When", item.createdAt, inner));
  const bodyRows = item.body ? ctx.wrapKeyValue("", item.body, inner) : [];
  return padDetail(
    [
      ...card({ tone: "muted", title: style("Story", "strong"), rows, width }),
      ...(bodyRows.length
        ? ["", ...card({ tone: "muted", title: style("Body", "strong"), rows: bodyRows, width })]
        : []),
    ],
    height,
  );
}

const TOPOLOGY_HEALTH_TONE: Record<string, Tone> = {
  active: "done",
  attention: "attn",
  idle: "idle",
  offline: "muted",
};

function topologyDot(health: string): string {
  return style("●", TOPOLOGY_HEALTH_TONE[health] ?? "muted");
}

export function renderTopologyScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "topology");
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const topology = ctx.topology ?? { projectName: "project", health: "idle", counts: null, rows: [] };
  const listLines: string[] = [];

  const c = topology.counts;
  listLines.push(
    `  ${topologyDot(topology.health)} ${style(topology.projectName, "strong")}${
      c ? ` ${style(`· ${c.worktrees} worktrees · ${c.agents} agents · ${c.services} services`, "muted")}` : ""
    }`,
  );
  listLines.push("");

  if (topology.rows.length === 0) {
    listLines.push(`  ${style("No worktrees.", "muted")}`);
  }
  let focusLine = 1;
  for (let i = 0; i < topology.rows.length; i++) {
    const row = topology.rows[i]!;
    const selected = i === ctx.topologyIndex;
    if (selected) focusLine = listLines.length + 1;
    const indent = row.depth > 0 ? "    " : "  ";
    const detail = row.detail ? ` ${style(`(${row.detail})`, "muted")}` : "";
    if (row.kind === "worktree") {
      const counts = `${style(`· ${row.status ?? ""}`.trimEnd(), "muted")}`;
      listLines.push(
        `${selected ? style("▸", "accent") : " "} ${indent}${topologyDot(row.health)} ${style(ctx.truncatePlain(row.label, 30), "strong")}${detail} ${counts}${trailingMark(selected)}`,
      );
    } else {
      listLines.push(
        `${selected ? style("▸", "accent") : " "} ${indent}${topologyDot(row.health)} ${chip(row.kind, "muted")} ${ctx.truncatePlain(row.label, 28)}${detail}${trailingMark(selected)}`,
      );
    }
  }

  ctx.writeFrame(
    composeScreenFrame({
      cols,
      rows,
      header,
      content: listLines,
      footerLines: [
        footerHints(
          "[↑↓] select  [Tab] details  [Enter] open  [r] refresh  [d/c/p/L/t/g] screens  [Esc] dashboard  [q] quit",
        ),
      ],
      focusLine,
      twoPane,
      rightPanel: (width, height) => renderTopologyDetails(ctx, width, height),
    }).frame,
  );
}

export function renderTopologyDetails(ctx: any, width: number, height: number): string[] {
  const row = ctx.topology?.rows?.[ctx.topologyIndex];
  if (!row) return new Array(height).fill("");
  const inner = Math.max(8, width - 4);
  const title = row.kind === "worktree" ? "Worktree" : row.kind === "service" ? "Service" : "Agent";
  const rows: string[] = [];
  rows.push(...ctx.wrapKeyValue("Name", row.label, inner));
  rows.push(...ctx.wrapKeyValue("Health", row.health, inner));
  if (row.detail) rows.push(...ctx.wrapKeyValue(row.kind === "worktree" ? "Branch" : "Detail", row.detail, inner));
  if (row.status) rows.push(...ctx.wrapKeyValue("Status", row.status, inner));
  if (row.worktreePath) rows.push(...ctx.wrapKeyValue("Worktree", row.worktreePath, inner));
  if (row.sessionId) rows.push(...ctx.wrapKeyValue("Session", row.sessionId, inner));
  if (row.serviceId) rows.push(...ctx.wrapKeyValue("Service", row.serviceId, inner));
  return padDetail([...card({ tone: "muted", title: style(title, "strong"), rows, width })], height);
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
  let frame = composeScreenFrame({
    cols,
    rows,
    header,
    content: listLines,
    footerLines: [
      footerHints(
        "[↑↓] select  [Tab] details  [d/c/p/L/t/g] screens  [1-9/Enter] resurrect  [x] delete worktree  [Esc] dashboard  [q] quit",
      ),
    ],
    focusLine,
    twoPane,
    rightPanel: (width, height) => renderGraveyardDetails(ctx, width, height),
  }).frame;
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
    if (selected.entry.graveyardedAt)
      lines.push(...ctx.wrapKeyValue("Graveyarded", formatRelativeRecency(selected.entry.graveyardedAt), width));
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

const LIBRARY_KIND_TONE: Record<string, Tone> = { doc: "info", plan: "work" };

export function renderLibraryScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header = screenHeader(ctx, cols, "library");
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const entries = ctx.libraryEntries ?? [];
  const listLines: string[] = [];

  if (entries.length === 0) {
    listLines.push(`  ${style("Library", "strong")}`);
    listLines.push(`    ${style("No project docs or plans yet.", "muted")}`);
  } else {
    listLines.push(`  ${style("Library", "strong")}`);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const selected = i === ctx.libraryIndex;
      const tone = LIBRARY_KIND_TONE[entry.kind] ?? "muted";
      const sub = entry.kind === "plan" && entry.sessionId ? ` ${style(`(${entry.sessionId})`, "muted")}` : "";
      const when = ` ${style(`· ${formatRelativeRecency(entry.updatedAt)}`, "muted")}`;
      listLines.push(
        `${marker(selected)}${itemNumber(i)} ${style(`[${entry.kind}]`, tone)} ${style(ctx.truncatePlain(entry.title, 38), "strong")}${sub}${when}${trailingMark(selected)}`,
      );
    }
  }
  const focusLine = entries.length === 0 ? 1 : ctx.libraryIndex + 2;
  const selectedPath = entries[ctx.libraryIndex]?.path;
  const pathFlash = ctx.libraryPathFlash === selectedPath ? selectedPath : undefined;
  const footerLines = [
    footerHints(
      "[↑↓] select  [Tab] details  [d/c/p/L/t/g] screens  [Enter] show path  [r] refresh  [Esc] dashboard  [q] quit",
    ),
  ];
  if (pathFlash) footerLines.push(style(`Path: ${pathFlash}`, "muted"));
  ctx.writeFrame(
    composeScreenFrame({
      cols,
      rows,
      header,
      content: listLines,
      footerLines,
      focusLine,
      twoPane,
      rightPanel: (width, height) => renderLibraryDetails(ctx, width, height),
    }).frame,
  );
}

export function renderLibraryDetails(ctx: any, width: number, height: number): string[] {
  const entry = ctx.libraryEntries?.[ctx.libraryIndex];
  if (!entry) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push(style("Details", "strong"));
  lines.push(...ctx.wrapKeyValue("Title", entry.title, width));
  lines.push(...ctx.wrapKeyValue("Kind", entry.kind, width));
  if (entry.sessionId) lines.push(...ctx.wrapKeyValue("Session", entry.sessionId, width));
  lines.push(...ctx.wrapKeyValue("Updated", entry.updatedAt, width));
  lines.push(...ctx.wrapKeyValue("Path", entry.path, width));
  lines.push("");
  lines.push(style("Preview", "strong"));
  const bodyLines = (entry.preview && entry.preview.length > 0 ? entry.preview : "(empty)").split(/\r?\n/);
  for (const line of bodyLines) {
    if (lines.length >= height) break;
    lines.push(line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line);
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}
