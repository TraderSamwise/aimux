import type {
  DashboardService,
  DashboardSession,
  DashboardWorktreeRemovalInfo,
  MainCheckoutInfo,
  WorktreeGroup,
} from "../../dashboard/index.js";
import { derivedStatusLabel } from "../../dashboard/index.js";
import { formatRelativeRecency } from "../../recency.js";
import { sessionSemanticCompactHint } from "../../session-semantics.js";
import { center, composeTwoPane, stripAnsi, truncate, wrapKeyValue } from "../render/text.js";

type DashboardNavLevel = "worktrees" | "sessions";

export interface DashboardRenderState {
  sessions: DashboardSession[];
  services: DashboardService[];
  worktreeGroups: WorktreeGroup[];
  hasWorktrees: boolean;
  focusedWorktreePath?: string;
  navLevel: DashboardNavLevel;
  selectedSessionId?: string;
  selectedServiceId?: string;
  runtimeLabel?: string;
  mainCheckout: MainCheckoutInfo;
  worktreeRemoval?: DashboardWorktreeRemovalInfo;
  detailsPaneVisible: boolean;
  scrollOffset: number;
  derivedStatusLabel: typeof derivedStatusLabel;
}

const STATUS_ICONS: Record<DashboardSession["status"], string> = {
  running: "\x1b[33m●\x1b[0m",
  idle: "\x1b[32m●\x1b[0m",
  waiting: "\x1b[36m◉\x1b[0m",
  exited: "\x1b[31m○\x1b[0m",
  offline: "\x1b[2m○\x1b[0m",
};

const SERVICE_ICONS: Record<DashboardService["status"], string> = {
  running: "\x1b[32m◆\x1b[0m",
  exited: "\x1b[31m◇\x1b[0m",
  offline: "\x1b[2m◇\x1b[0m",
};

export function renderDashboardFrame(
  state: DashboardRenderState,
  cols: number,
  rows: number,
): { frame: string; scrollOffset: number } {
  const contentWidth = Math.max(72, cols);
  const padBlockLine = (line: string): string => line;
  const centerInBlock = (line: string): string => center(line, contentWidth).slice(0, cols);
  const wrapCommandGroups = (line: string): string[] => {
    const groups = line
      .trim()
      .split(/\s{2,}/)
      .filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (const group of groups) {
      const next = current ? `${current}  ${group}` : group;
      if (stripAnsi(next).length <= contentWidth) {
        current = next;
      } else {
        if (current) lines.push(current);
        current = group;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  let renderSessionCounter = 0;

  const renderSession = (session: DashboardSession, indent: string): string => {
    const num = ++renderSessionCounter;
    const isSelected = state.navLevel === "sessions" && session.id === state.selectedSessionId;
    const prefix = isSelected ? "\x1b[33m▸\x1b[0m " : "  ";
    const taskBadge = session.taskDescription ? ` \x1b[2;35m⧫ ${truncate(session.taskDescription, 40)}\x1b[0m` : "";
    const threadBadge =
      (session.threadUnreadCount ?? 0) > 0 ||
      (session.threadWaitingOnMeCount ?? 0) > 0 ||
      (session.threadWaitingOnThemCount ?? 0) > 0
        ? ` \x1b[2;34m💬 ${session.threadUnreadCount ?? 0}/${session.threadWaitingOnMeCount ?? 0}/${session.threadWaitingOnThemCount ?? 0}\x1b[0m`
        : "";
    const pendingBadge =
      (session.threadPendingCount ?? 0) > 0 ? ` \x1b[2;31m⇢ ${session.threadPendingCount}\x1b[0m` : "";
    const workflowBadge =
      (session.workflowOnMeCount ?? 0) > 0 ||
      (session.workflowBlockedCount ?? 0) > 0 ||
      (session.workflowFamilyCount ?? 0) > 0
        ? ` \x1b[2;35mwf ${session.workflowOnMeCount ?? 0}/${session.workflowBlockedCount ?? 0}/${session.workflowFamilyCount ?? 0}\x1b[0m`
        : "";
    const workflowHint = session.workflowNextAction
      ? ` \x1b[2;33m→ ${truncate(session.workflowNextAction, 24)}\x1b[0m`
      : "";
    const attentionBadge =
      session.attention === "error"
        ? " \x1b[31m✗\x1b[0m"
        : session.attention === "needs_input"
          ? " \x1b[33m?\x1b[0m"
          : session.attention === "blocked"
            ? " \x1b[35m!\x1b[0m"
            : "";
    const unseenBadge = session.unseenCount && session.unseenCount > 0 ? ` \x1b[36m${session.unseenCount}\x1b[0m` : "";
    const lastUsedHint = session.lastUsedAt ? ` \x1b[2m· ${formatRelativeRecency(session.lastUsedAt)}\x1b[0m` : "";

    if (session.remoteInstancePid) {
      const icon = "\x1b[2;36m◈\x1b[0m";
      const ownerTag = `\x1b[2mother tab (PID ${session.remoteInstancePid})\x1b[0m`;
      const identity = session.label ?? session.command;
      const headlineText = session.headline ? ` \x1b[2m· ${truncate(session.headline, 40)}\x1b[0m` : "";
      const remoteRoleTag = session.role ? ` \x1b[2;36m(${session.role})\x1b[0m` : "";
      return `${indent}${prefix}${icon} [${num}] ${identity}${remoteRoleTag}${headlineText}${threadBadge}${pendingBadge}${workflowBadge}${workflowHint}${attentionBadge}${unseenBadge}${lastUsedHint} — ${ownerTag}`;
    }

    const icon = STATUS_ICONS[session.status];
    const statusLabel = state.derivedStatusLabel(session);
    const compactHintValue = session.semantic ? sessionSemanticCompactHint(session.semantic) : null;
    const compactHint =
      compactHintValue && compactHintValue !== statusLabel ? ` \x1b[2m· ${compactHintValue}\x1b[0m` : "";
    const roleTag = session.role ? ` \x1b[36m(${session.role})\x1b[0m` : "";
    const identity = session.label ?? session.command;
    const headlineText = session.headline ? ` \x1b[2m· ${truncate(session.headline, 50)}\x1b[0m` : "";
    return `${indent}${prefix}${icon} [${num}] ${identity}${roleTag} — ${statusLabel}${compactHint}${headlineText}${taskBadge}${threadBadge}${pendingBadge}${workflowBadge}${workflowHint}${attentionBadge}${unseenBadge}${lastUsedHint}`;
  };

  const renderService = (service: DashboardService, indent: string): string => {
    const isSelected = state.navLevel === "sessions" && service.id === state.selectedServiceId;
    const prefix = isSelected ? "\x1b[33m▸\x1b[0m " : "  ";
    const icon = SERVICE_ICONS[service.status];
    const identity = service.label ?? service.command;
    const statusLabel = service.pendingAction ?? service.status;
    const commandHint = service.foregroundCommand ? ` \x1b[2m· ${truncate(service.foregroundCommand, 22)}\x1b[0m` : "";
    const pidHint = service.pid ? ` \x1b[2m(pid ${service.pid})\x1b[0m` : "";
    const previewHint = service.previewLine ? ` \x1b[2m· ${truncate(service.previewLine, 40)}\x1b[0m` : "";
    const lastUsedHint = service.lastUsedAt ? ` \x1b[2m· ${formatRelativeRecency(service.lastUsedAt)}\x1b[0m` : "";
    return `${indent}${prefix}${icon} ${identity} \x1b[2m[service]\x1b[0m — ${statusLabel}${commandHint}${pidHint}${previewHint}${lastUsedHint}`;
  };

  const renderWorktreeGrouped = (lines: string[]): void => {
    const isFocused = (wtPath: string | undefined) => wtPath === state.focusedWorktreePath;
    const wtCursor = "\x1b[33m▸\x1b[0m";
    const wtSessionMap = new Map<string, DashboardSession[]>();
    const wtServiceMap = new Map<string, DashboardService[]>();
    const mainSessions: DashboardSession[] = [];
    const mainServices: DashboardService[] = [];

    for (const session of state.sessions) {
      if (!session.worktreePath) {
        mainSessions.push(session);
      } else {
        const group = wtSessionMap.get(session.worktreePath) ?? [];
        group.push(session);
        wtSessionMap.set(session.worktreePath, group);
      }
    }
    for (const service of state.services) {
      if (!service.worktreePath) {
        mainServices.push(service);
      } else {
        const group = wtServiceMap.get(service.worktreePath) ?? [];
        group.push(service);
        wtServiceMap.set(service.worktreePath, group);
      }
    }

    const focused = isFocused(undefined);
    const prefix = focused && state.navLevel === "worktrees" ? ` ${wtCursor}` : "  ";
    const highlight = focused ? "\x1b[1;33m" : "\x1b[1m";
    const mainBranch = state.mainCheckout.branch ? ` \x1b[2m${state.mainCheckout.branch}\x1b[0m` : "";
    const mainLabel = `${state.mainCheckout.name}${mainBranch}`;
    if (mainSessions.length > 0 || mainServices.length > 0) {
      lines.push(`${prefix} ${highlight}${mainLabel}\x1b[0m`);
      for (const session of mainSessions) lines.push(renderSession(session, "    "));
      for (const service of mainServices) lines.push(renderService(service, "    "));
      lines.push("");
    } else {
      lines.push(`${prefix} ${highlight}${mainLabel}\x1b[0m`);
    }

    const renderedPaths = new Set<string>();
    for (const group of state.worktreeGroups) {
      const sessions = wtSessionMap.get(group.path) ?? [];
      const services = wtServiceMap.get(group.path) ?? [];
      const gFocused = isFocused(group.path);
      const gPrefix = gFocused && state.navLevel === "worktrees" ? ` ${wtCursor}` : "  ";
      const gHighlight = gFocused ? "\x1b[1;33m" : "";
      const gReset = gFocused ? "\x1b[0m" : "";
      const gPending = group.removing || group.pending ? " \x1b[2;33m(removing...)\x1b[0m" : "";

      if (sessions.length > 0 || services.length > 0) {
        lines.push(
          `${gPrefix} ${gHighlight}\x1b[1m${group.name}\x1b[0m${gReset} \x1b[2m${group.branch}\x1b[0m${gPending}`,
        );
        for (const session of sessions) lines.push(renderSession(session, "    "));
        for (const service of services) lines.push(renderService(service, "    "));
        lines.push("");
      } else {
        lines.push(`${gPrefix} \x1b[2m${gHighlight}${group.name}\x1b[0m \x1b[2m${group.branch}\x1b[0m${gPending}`);
      }
      renderedPaths.add(group.path);
    }

    const orphanPaths = new Set<string>([...Array.from(wtSessionMap.keys()), ...Array.from(wtServiceMap.keys())]);
    for (const path of orphanPaths) {
      if (!path || renderedPaths.has(path)) continue;
      const sessions = wtSessionMap.get(path) ?? [];
      const services = wtServiceMap.get(path) ?? [];
      const exemplar = sessions[0] ?? services[0];
      const name = exemplar?.worktreeName ?? "unknown";
      const branch = exemplar?.worktreeBranch ?? "unknown";
      lines.push(`  \x1b[1m${name}\x1b[0m \x1b[2m${branch}\x1b[0m`);
      for (const session of sessions) lines.push(renderSession(session, "    "));
      for (const service of services) lines.push(renderService(service, "    "));
      lines.push("");
    }
  };

  const findFocusLine = (content: string[]): number => {
    for (let i = 0; i < content.length; i++) {
      const stripped = content[i].replace(/\x1b\[[0-9;]*m/g, "");
      if (stripped.includes("▸")) return i;
    }
    return -1;
  };

  const buildHelpLine = (): string => {
    const selectedSession = state.selectedSessionId
      ? state.sessions.find((s) => s.id === state.selectedSessionId)
      : undefined;
    const selectedService = state.selectedServiceId
      ? state.services.find((s) => s.id === state.selectedServiceId)
      : undefined;
    const xLabel = selectedService
      ? "[x] stop"
      : selectedSession?.status === "offline"
        ? "[x] kill"
        : selectedSession?.remoteInstancePid
          ? ""
          : selectedSession
            ? "[x] stop"
            : "";
    const rLabel = selectedSession && !selectedSession.remoteInstancePid ? "  [r] name" : "";
    const enterLabel = selectedService
      ? "Enter open"
      : selectedSession?.remoteInstancePid
        ? "Enter takeover"
        : selectedSession?.status === "offline"
          ? "Enter resume"
          : "Enter focus";

    if (state.sessions.length === 0 && !state.hasWorktrees) {
      return " [u] attention  [a] activity  [t] threads  [i] inbox  [Tab] details  [c] new agent  [v] service  [f] fork  [S] msg  [H] handoff  [T] task  [o] thread  [R] reply  [p] plans  [g] graveyard  [?] help  [q] quit ";
    }
    if (state.hasWorktrees && state.navLevel === "sessions") {
      const xPart = xLabel ? `  ${xLabel}` : "";
      return ` ↑↓ items  ${enterLabel}  Esc back  [u] attention  [a] activity  [t] threads  [i] inbox  [Tab] details  [c] new agent  [v] service  [f] fork  [S] msg  [H] handoff  [T] task  [o] thread  [R] reply  [m] migrate${xPart}${rLabel}  [p] plans  [g] graveyard  [?] help  [q] quit `;
    }
    if (state.hasWorktrees) {
      return ` ↑↓ worktrees  Enter step in  [u] attention  [a] activity  [t] threads  [i] inbox  [Tab] details  [c] new agent  [v] service  [f] fork(step in)  [w] worktree  [p] plans  [g] graveyard  [?] help  [q] quit `;
    }
    if (state.sessions.length > 0) {
      const xPart = xLabel ? `  ${xLabel}` : "";
      return ` ↑↓ select  ${enterLabel}  [u] attention  [a] activity  [t] threads  [i] inbox  [Tab] details  [c] new agent  [v] service  [f] fork  [S] msg  [H] handoff  [T] task  [o] thread  [R] reply  [w] worktree${xPart}${rLabel}  [p] plans  [g] graveyard  [?] help  [q] quit `;
    }
    return " [u] attention  [a] activity  [t] threads  [i] inbox  [Tab] details  [c] new agent  [v] service  [f] fork  [S] msg  [H] handoff  [T] task  [o] thread  [R] reply  [w] worktree  [p] plans  [g] graveyard  [?] help  [q] quit ";
  };

  const renderSelectedDetailsPanel = (width: number, height: number): string[] => {
    const selectedSession = state.selectedSessionId
      ? state.sessions.find((session) => session.id === state.selectedSessionId)
      : undefined;
    const selectedService = state.selectedServiceId
      ? state.services.find((service) => service.id === state.selectedServiceId)
      : undefined;
    if (!selectedSession && !selectedService) {
      const focusedWorktreePath = state.focusedWorktreePath;
      const focusedSessions = state.sessions.filter(
        (session) => (session.worktreePath ?? undefined) === focusedWorktreePath,
      );
      const focusedServices = state.services.filter(
        (service) => (service.worktreePath ?? undefined) === focusedWorktreePath,
      );
      const worktree: { name: string; branch: string; path: string } | { name: string; branch: string; path: string } =
        focusedWorktreePath === undefined
          ? {
              name: state.mainCheckout.name,
              branch: state.mainCheckout.branch,
              path: "(main checkout)",
            }
          : (state.worktreeGroups.find((group) => group.path === focusedWorktreePath) ?? {
              name: focusedSessions[0]?.worktreeName ?? focusedServices[0]?.worktreeName ?? "Worktree",
              branch: focusedSessions[0]?.worktreeBranch ?? focusedServices[0]?.worktreeBranch ?? "",
              path: focusedWorktreePath,
            });

      const lines: string[] = ["\x1b[1mWorktree\x1b[0m"];
      lines.push(...wrapKeyValue("Name", worktree.name, width));
      if (worktree.branch) lines.push(...wrapKeyValue("Branch", worktree.branch, width));
      lines.push(...wrapKeyValue("Path", worktree.path, width));
      lines.push(...wrapKeyValue("Agents", String(focusedSessions.length), width));
      lines.push(...wrapKeyValue("Services", String(focusedServices.length), width));
      const activeWorktreeRemoval =
        state.worktreeRemoval?.path === focusedWorktreePath ? state.worktreeRemoval : undefined;
      if (activeWorktreeRemoval) {
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - activeWorktreeRemoval.startedAt) / 1000));
        lines.push(...wrapKeyValue("Status", "removing", width));
        lines.push(...wrapKeyValue("Elapsed", `${elapsedSeconds}s`, width));
        const detailLines = (activeWorktreeRemoval.stderr ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-3);
        if (detailLines.length > 0) {
          lines.push(...wrapKeyValue("Progress", detailLines.join(" | "), width));
        }
      }
      if (focusedSessions.length > 0) {
        lines.push(
          ...wrapKeyValue(
            "Active",
            focusedSessions
              .map((session) => session.label ?? session.command)
              .slice(0, 3)
              .join(", "),
            width,
          ),
        );
      }
      if (focusedServices.length > 0) {
        lines.push(
          ...wrapKeyValue(
            "Running",
            focusedServices
              .map((service) => service.label ?? service.command)
              .slice(0, 3)
              .join(", "),
            width,
          ),
        );
      }
      while (lines.length < height) lines.push("");
      return lines.slice(0, height);
    }

    const lines: string[] = ["\x1b[1mDetails\x1b[0m"];
    if (selectedService) {
      lines.push(
        ...wrapKeyValue(
          "Service",
          `${selectedService.label ?? selectedService.command} (${selectedService.id})`,
          width,
        ),
      );
      lines.push(...wrapKeyValue("Command", selectedService.command, width));
      if (selectedService.foregroundCommand)
        lines.push(...wrapKeyValue("Foreground", selectedService.foregroundCommand, width));
      if (selectedService.pid) lines.push(...wrapKeyValue("PID", String(selectedService.pid), width));
      if (selectedService.worktreeName || selectedService.worktreeBranch) {
        lines.push(
          ...wrapKeyValue(
            "Worktree",
            `${selectedService.worktreeName ?? "main"}${selectedService.worktreeBranch ? ` · ${selectedService.worktreeBranch}` : ""}`,
            width,
          ),
        );
      }
      if (selectedService.cwd) lines.push(...wrapKeyValue("CWD", selectedService.cwd, width));
      lines.push(...wrapKeyValue("Status", selectedService.status, width));
      if (selectedService.previewLine) lines.push(...wrapKeyValue("Preview", selectedService.previewLine, width));
      while (lines.length < height) lines.push("");
      return lines.slice(0, height);
    }

    const selected = selectedSession!;
    lines.push(...wrapKeyValue("Agent", `${selected.label ?? selected.command} (${selected.id})`, width));
    lines.push(...wrapKeyValue("Tool", selected.command, width));
    if (selected.worktreeName || selected.worktreeBranch) {
      lines.push(
        ...wrapKeyValue(
          "Worktree",
          `${selected.worktreeName ?? "main"}${selected.worktreeBranch ? ` · ${selected.worktreeBranch}` : ""}`,
          width,
        ),
      );
    }
    if (selected.cwd) lines.push(...wrapKeyValue("CWD", selected.cwd, width));
    if (selected.foregroundCommand) lines.push(...wrapKeyValue("Foreground", selected.foregroundCommand, width));
    if (selected.pid) lines.push(...wrapKeyValue("PID", String(selected.pid), width));
    if (selected.prNumber || selected.prTitle || selected.prUrl) {
      const prHeader = [`PR${selected.prNumber ? ` #${selected.prNumber}` : ""}`];
      if (selected.prTitle) prHeader.push(selected.prTitle);
      lines.push(...wrapKeyValue("PR", prHeader.join(": "), width));
      if (selected.prUrl) lines.push(...wrapKeyValue("URL", selected.prUrl, width));
    }
    if (selected.repoOwner || selected.repoName)
      lines.push(...wrapKeyValue("Repo", `${selected.repoOwner ?? "?"}/${selected.repoName ?? "?"}`, width));
    if (selected.repoRemote) lines.push(...wrapKeyValue("Remote", selected.repoRemote, width));
    if (selected.previewLine) lines.push(...wrapKeyValue("Preview", selected.previewLine, width));
    if (selected.activity) lines.push(...wrapKeyValue("Activity", selected.activity, width));
    if (selected.attention && selected.attention !== "normal")
      lines.push(...wrapKeyValue("Attention", selected.attention, width));
    if (selected.unseenCount && selected.unseenCount > 0)
      lines.push(...wrapKeyValue("Unseen", String(selected.unseenCount), width));
    if (selected.lastEvent?.message) lines.push(...wrapKeyValue("Last", selected.lastEvent.message, width));
    if (selected.threadName || selected.threadId)
      lines.push(...wrapKeyValue("Thread", selected.threadName ?? selected.threadId ?? "", width));
    if (
      (selected.threadUnreadCount ?? 0) > 0 ||
      (selected.threadWaitingOnMeCount ?? 0) > 0 ||
      (selected.threadWaitingOnThemCount ?? 0) > 0 ||
      (selected.threadPendingCount ?? 0) > 0
    ) {
      lines.push(
        ...wrapKeyValue(
          "Threads",
          `${selected.threadUnreadCount ?? 0} unread · ${selected.threadWaitingOnMeCount ?? 0} on me · ${selected.threadWaitingOnThemCount ?? 0} on them · ${selected.threadPendingCount ?? 0} pending`,
          width,
        ),
      );
    }
    if (
      (selected.workflowOnMeCount ?? 0) > 0 ||
      (selected.workflowBlockedCount ?? 0) > 0 ||
      (selected.workflowFamilyCount ?? 0) > 0 ||
      selected.workflowTopLabel
    ) {
      const summary = [
        `${selected.workflowOnMeCount ?? 0} on me`,
        `${selected.workflowBlockedCount ?? 0} blocked`,
        `${selected.workflowFamilyCount ?? 0} families`,
        selected.workflowTopLabel ? `top: ${selected.workflowTopLabel}` : undefined,
        selected.workflowNextAction ? `next: ${selected.workflowNextAction}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(...wrapKeyValue("Workflow", summary, width));
    }
    if ((selected.services?.length ?? 0) > 0) {
      lines.push(...wrapKeyValue("Services", selected.services!.map((s) => s.url ?? `:${s.port}`).join(", "), width));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  };

  const header: string[] = [
    "",
    centerInBlock(
      `\x1b[1maimux\x1b[0m — agent multiplexer${state.runtimeLabel ? `  \x1b[32m● ${state.runtimeLabel}\x1b[0m` : ""}`,
    ),
    "─".repeat(Math.max(0, cols)),
    "",
  ];
  const content: string[] = [];
  if (state.sessions.length === 0 && state.worktreeGroups.length === 0) {
    content.push(centerInBlock("No sessions. Press [c] to create one."));
  } else if (state.hasWorktrees) {
    renderWorktreeGrouped(content);
  } else {
    for (const session of state.sessions) content.push(renderSession(session, "  "));
  }

  const helpLines = wrapCommandGroups(buildHelpLine());
  const footer: string[] = ["─".repeat(Math.max(0, cols)), ...helpLines.map((line) => centerInBlock(line))];
  const viewportHeight = rows - header.length - footer.length;
  const twoPane = cols >= 72 && state.detailsPaneVisible;
  let scrollOffset = state.scrollOffset;
  const focusLine = findFocusLine(content);
  const maxScroll = Math.max(0, content.length - viewportHeight);
  if (focusLine >= 0) {
    if (focusLine < scrollOffset + 1) {
      scrollOffset = Math.max(0, focusLine - 1);
    } else if (focusLine >= scrollOffset + viewportHeight - 1) {
      scrollOffset = Math.min(maxScroll, focusLine - viewportHeight + 2);
    }
  }
  scrollOffset = Math.min(scrollOffset, maxScroll);
  const visibleContent = content.slice(scrollOffset, scrollOffset + viewportHeight);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset < maxScroll;
  if (canScrollUp) visibleContent[0] = centerInBlock("\x1b[2m▲ more ▲\x1b[0m");
  if (canScrollDown && visibleContent.length > 0)
    visibleContent[visibleContent.length - 1] = centerInBlock("\x1b[2m▼ more ▼\x1b[0m");
  while (visibleContent.length < viewportHeight) visibleContent.push("");

  let bodyLines = visibleContent;
  if (twoPane) {
    const rightPanel = renderSelectedDetailsPanel(
      Math.max(24, contentWidth - Math.max(32, Math.floor(contentWidth * 0.58)) - 3),
      viewportHeight,
    );
    bodyLines = composeTwoPane(visibleContent, rightPanel, contentWidth).map(padBlockLine);
  } else {
    bodyLines = visibleContent.map((line) => padBlockLine(line));
  }
  return {
    frame: "\x1b[2J\x1b[H" + [...header, ...bodyLines, ...footer].join("\r\n"),
    scrollOffset,
  };
}
