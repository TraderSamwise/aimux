export function renderWorkflowScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header: string[] = [];
  header.push("");
  header.push(
    ctx.centerInWidth(`\x1b[1maimux\x1b[0m — workflow \x1b[2m[${ctx.describeWorkflowFilter()}]\x1b[0m`, cols),
  );
  header.push(ctx.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
  header.push("");
  const footer = ctx.centerInWidth(
    "[↑↓] select  [f] filter  [Tab] details  [d/a/y/t/p/g] screens  [s] reply  [a] accept  [b] block  [c/x] complete  [P] approve  [J] changes  [E] reopen  [Enter] thread  [Esc] dashboard  [q] quit",
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.workflowEntries.length === 0) {
    listLines.push("  Workflow");
    listLines.push("    No open task/review/handoff workflow items.");
  } else {
    listLines.push("  Workflow");
    for (let i = 0; i < ctx.workflowEntries.length; i++) {
      const entry = ctx.workflowEntries[i]!;
      const selected = i === ctx.workflowIndex;
      const marker = selected ? "\x1b[33m▸\x1b[0m " : "  ";
      const pending = entry.pendingDeliveries > 0 ? ` \x1b[31m⇢ ${entry.pendingDeliveries}\x1b[0m` : "";
      const unread = (entry.thread.unreadBy?.length ?? 0) > 0 ? ` \x1b[36m${entry.thread.unreadBy!.length}\x1b[0m` : "";
      const family = entry.familyTaskIds.length > 1 ? ` \x1b[35m⤳${entry.familyTaskIds.length}\x1b[0m` : "";
      const latest = entry.latestMessage?.body
        ? ` \x1b[2m· ${ctx.truncatePlain(entry.latestMessage.body, 28)}\x1b[0m`
        : "";
      listLines.push(
        `${marker}[${i + 1}] ${entry.displayTitle} \x1b[2m(${entry.thread.kind})\x1b[0m — ${entry.stateLabel}${family}${unread}${pending}${latest}${selected ? " \x1b[33m◀\x1b[0m" : ""}`,
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
  ctx.writeFrame(
    "\x1b[2J\x1b[H" +
      [...header, ...body, ctx.centerInWidth("─".repeat(Math.min(cols - 4, 72)), cols), footer].join("\r\n"),
  );
}

export function renderWorkflowDetails(ctx: any, width: number, height: number): string[] {
  const entry = ctx.workflowEntries[ctx.workflowIndex];
  if (!entry) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push("\x1b[1mWorkflow\x1b[0m");
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
  lines.push("\x1b[1mLatest\x1b[0m");
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
  const header: string[] = [];
  header.push("");
  header.push(ctx.centerInWidth("\x1b[1maimux\x1b[0m — activity", cols));
  header.push(ctx.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
  header.push("");
  const footer = ctx.centerInWidth(
    "[↑↓] select  [Tab] details  [d/a/y/t/p/g] screens  [1-9/Enter] focus  [u] next attention  [Esc] dashboard  [q] quit",
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.activityEntries.length === 0) {
    listLines.push("  Activity");
    listLines.push("    No sessions currently need attention.");
  } else {
    listLines.push("  Activity");
    for (let i = 0; i < ctx.activityEntries.length; i++) {
      const entry = ctx.activityEntries[i]!;
      const selected = i === ctx.activityIndex;
      const marker = selected ? "\x1b[33m▸\x1b[0m " : "  ";
      const identity = entry.label ?? entry.command;
      const roleTag = entry.role ? ` \x1b[36m(${entry.role})\x1b[0m` : "";
      const wt = entry.worktreeName
        ? ` \x1b[2m· ${ctx.truncatePlain(entry.worktreeName, 18)}${entry.worktreeBranch ? `@${ctx.truncatePlain(entry.worktreeBranch, 18)}` : ""}\x1b[0m`
        : "";
      const state =
        entry.attention && entry.attention !== "normal" ? entry.attention : (entry.activity ?? entry.status);
      const unseen = (entry.unseenCount ?? 0) > 0 ? ` \x1b[36m${entry.unseenCount}\x1b[0m` : "";
      const service = entry.services?.[0]
        ? ` \x1b[2m· ${entry.services[0].port ? `:${entry.services[0].port}` : ctx.truncatePlain(entry.services[0].url ?? "", 16)}\x1b[0m`
        : "";
      listLines.push(
        `${marker}[${i + 1}] ${identity}${roleTag} — ${state}${unseen}${wt}${service}${selected ? " \x1b[33m◀\x1b[0m" : ""}`,
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
  ctx.writeFrame(
    "\x1b[2J\x1b[H" +
      [...header, ...body, ctx.centerInWidth("─".repeat(Math.min(cols - 4, 72)), cols), footer].join("\r\n"),
  );
}

export function renderThreadsScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header: string[] = [];
  header.push("");
  header.push(ctx.centerInWidth("\x1b[1maimux\x1b[0m — threads", cols));
  header.push(ctx.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
  header.push("");
  const footer = ctx.centerInWidth(
    "[↑↓] select  [Tab] details  [d/a/y/t/p/g] screens  [s] reply  [a] accept  [c] complete  [b/o/x] state  [Enter] jump  [r] refresh  [Esc] dashboard  [q] quit",
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.threadEntries.length === 0) {
    listLines.push("  Threads");
    listLines.push("    No orchestration threads yet.");
  } else {
    listLines.push("  Threads");
    for (let i = 0; i < ctx.threadEntries.length; i++) {
      const entry = ctx.threadEntries[i]!;
      const selected = i === ctx.threadIndex;
      const marker = selected ? "\x1b[33m▸\x1b[0m " : "  ";
      const unread = (entry.thread.unreadBy?.length ?? 0) > 0 ? ` \x1b[36m${entry.thread.unreadBy!.length}\x1b[0m` : "";
      const waiting =
        (entry.thread.waitingOn?.length ?? 0) > 0 ? ` \x1b[35m→ ${entry.thread.waitingOn!.join(",")}\x1b[0m` : "";
      const pending = entry.pendingDeliveries > 0 ? ` \x1b[31m⇢ ${entry.pendingDeliveries}\x1b[0m` : "";
      const latest = entry.latestMessage?.body
        ? ` \x1b[2m· ${ctx.truncatePlain(entry.latestMessage.body, 34)}\x1b[0m`
        : "";
      listLines.push(
        `${marker}[${i + 1}] ${entry.displayTitle} \x1b[2m(${entry.thread.kind})\x1b[0m — ${entry.thread.status}${unread}${waiting}${pending}${latest}${selected ? " \x1b[33m◀\x1b[0m" : ""}`,
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
  ctx.writeFrame(
    "\x1b[2J\x1b[H" +
      [...header, ...body, ctx.centerInWidth("─".repeat(Math.min(cols - 4, 72)), cols), footer].join("\r\n"),
  );
}

export function renderThreadDetails(ctx: any, width: number, height: number): string[] {
  const entry = ctx.threadEntries[ctx.threadIndex];
  if (!entry) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push("\x1b[1mDetails\x1b[0m");
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
  lines.push("\x1b[1mMessages\x1b[0m");
  const messages = ctx.readMessages(entry.thread.id).slice(-Math.max(3, height - lines.length));
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

export function renderGraveyardScreen(ctx: any): void {
  const { cols, rows } = ctx.getViewportSize();
  const header: string[] = [];
  header.push("");
  header.push(ctx.centerInWidth("\x1b[1maimux\x1b[0m — graveyard", cols));
  header.push(ctx.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
  header.push("");
  const footer = ctx.centerInWidth(
    "[↑↓] select  [Tab] details  [d/a/y/t/p/g] screens  [1-9/Enter] resurrect  [Esc] dashboard  [q] quit",
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];
  if (ctx.graveyardEntries.length === 0) {
    listLines.push("  Graveyard");
    listLines.push("    (empty)");
  } else {
    listLines.push("  Graveyard");
    for (let i = 0; i < ctx.graveyardEntries.length; i++) {
      const s = ctx.graveyardEntries[i];
      const bsid = s.backendSessionId ? ` (${s.backendSessionId.slice(0, 8)}…)` : "";
      const identity = s.label ? ` — ${s.label}` : "";
      const headline = s.headline ? ` · ${s.headline}` : "";
      const marker = i === ctx.graveyardIndex ? "\x1b[33m▸\x1b[0m " : "  ";
      listLines.push(`    ${marker}[${i + 1}] ${s.command}:${s.id}${bsid}${identity}${headline}`);
    }
  }
  const focusLine = ctx.graveyardEntries.length === 0 ? 1 : ctx.graveyardIndex + 1;
  const body = ctx.composeSplitScreen(
    listLines,
    renderGraveyardDetails(ctx, Math.max(28, cols - Math.floor(cols * 0.56) - 3), viewportHeight),
    cols,
    viewportHeight,
    focusLine,
    twoPane,
  );
  ctx.writeFrame(
    "\x1b[2J\x1b[H" +
      [...header, ...body, ctx.centerInWidth("─".repeat(Math.min(cols - 4, 52)), cols), footer].join("\r\n"),
  );
}

export function renderGraveyardDetails(ctx: any, width: number, height: number): string[] {
  const selected = ctx.graveyardEntries[ctx.graveyardIndex];
  if (!selected) return new Array(height).fill("");
  const lines: string[] = [];
  const worktreeName = selected.worktreePath ? ctx.basename(selected.worktreePath) : undefined;
  lines.push("\x1b[1mDetails\x1b[0m");
  lines.push(...ctx.wrapKeyValue("Agent", selected.label ?? selected.id, width));
  lines.push(...ctx.wrapKeyValue("Session", selected.id, width));
  lines.push(...ctx.wrapKeyValue("Tool", selected.tool, width));
  lines.push(...ctx.wrapKeyValue("Config", selected.toolConfigKey, width));
  lines.push(...ctx.wrapKeyValue("Status", "offline", width));
  if (worktreeName) lines.push(...ctx.wrapKeyValue("Worktree", worktreeName, width));
  if (selected.worktreePath) lines.push(...ctx.wrapKeyValue("Path", selected.worktreePath, width));
  if (selected.backendSessionId) lines.push(...ctx.wrapKeyValue("Backend", selected.backendSessionId, width));
  if (selected.headline) lines.push(...ctx.wrapKeyValue("Headline", selected.headline, width));
  if (selected.command) lines.push(...ctx.wrapKeyValue("Command", selected.command, width));
  if (selected.args?.length) lines.push(...ctx.wrapKeyValue("Args", selected.args.join(" "), width));
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
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
  const header: string[] = [];
  header.push("");
  header.push(ctx.centerInWidth("\x1b[1maimux\x1b[0m — plans", cols));
  header.push(ctx.centerInWidth("─".repeat(Math.min(50, cols - 4)), cols));
  header.push("");
  const footer = ctx.centerInWidth(
    "[↑↓] select  [Tab] details  [d/a/y/t/p/g] screens  [e/Enter] edit  [r] refresh  [Esc] dashboard  [q] quit",
    cols,
  );
  const viewportHeight = rows - header.length - 2;
  const twoPane = cols >= 110 && ctx.dashboardState.detailsSidebarVisible;
  const listLines: string[] = [];

  if (ctx.planEntries.length === 0) {
    listLines.push("  No plan files found in .aimux/plans/");
  } else {
    listLines.push("  Plans");
    for (let i = 0; i < ctx.planEntries.length; i++) {
      const plan = ctx.planEntries[i];
      const selected = i === ctx.planIndex;
      const marker = selected ? "\x1b[33m▸\x1b[0m " : "  ";
      const identity = plan.label ?? plan.tool ?? "unknown";
      const worktree = plan.worktree ?? "main";
      const updated = plan.updatedAt ? ` · ${plan.updatedAt.replace("T", " ").slice(0, 16)}` : "";
      listLines.push(`${marker}[${i + 1}] ${identity} \x1b[2m(${plan.sessionId})\x1b[0m · ${worktree}${updated}`);
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
  ctx.writeFrame(
    "\x1b[2J\x1b[H" +
      [...header, ...body, ctx.centerInWidth("─".repeat(Math.min(cols - 4, 56)), cols), footer].join("\r\n"),
  );
}

export function renderPlanDetails(ctx: any, width: number, height: number): string[] {
  const selectedPlan = ctx.planEntries[ctx.planIndex];
  if (!selectedPlan) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push("\x1b[1mDetails\x1b[0m");
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
  lines.push("\x1b[1mPreview\x1b[0m");
  for (const previewLine of buildPlanPreview(ctx, selectedPlan.content, width, Math.max(4, height - lines.length))) {
    lines.push(previewLine);
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}
