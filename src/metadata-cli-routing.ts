import { PROJECT_API_ROUTES } from "./project-api-contract.js";

type MetadataCliResult =
  | { ok: true; command: "endpoint" }
  | { ok: true; command: "post"; routePath: string; body: Record<string, unknown> }
  | { ok: false; error: string };

function stripCommand(args: string[]): string[] {
  return args[0] === "metadata" ? args.slice(1) : args;
}

function stripOptionTerminator(args: string[]): string[] {
  const terminatorIndex = args.indexOf("--");
  if (terminatorIndex === -1) return args;
  return [...args.slice(0, terminatorIndex), ...args.slice(terminatorIndex + 1)];
}

function optionValue(args: string[], index: number, name: string): { value: string; nextIndex: number } | null {
  const arg = args[index];
  if (arg.startsWith(`${name}=`)) {
    const value = arg.slice(name.length + 1);
    return value ? { value, nextIndex: index } : null;
  }
  if (arg !== name) return null;
  const value = args[index + 1];
  return value === undefined || value === "" ? null : { value, nextIndex: index + 1 };
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function parseRuntimeMetadataCliArgs(rawArgs: string[]): MetadataCliResult {
  const args = stripOptionTerminator(stripCommand(rawArgs));
  const subcommand = args[0] ?? "";
  if (subcommand === "endpoint" && args.length === 1) return { ok: true, command: "endpoint" };

  if (subcommand === "event") {
    const session = args[1];
    const kind = args[2];
    if (!session || !kind || session.startsWith("-") || kind.startsWith("-")) {
      return { ok: false, error: "metadata event requires <session> and <kind>" };
    }
    const event: Record<string, unknown> = { kind };
    const optionMap = new Map([
      ["--message", "message"],
      ["--source", "source"],
      ["--tone", "tone"],
      ["--thread-id", "threadId"],
      ["--thread-name", "threadName"],
    ]);
    for (let index = 3; index < args.length; index += 1) {
      const option = [...optionMap.keys()].find((name) => args[index] === name || args[index].startsWith(`${name}=`));
      if (!option) return { ok: false, error: `unsupported metadata event argument: ${args[index]}` };
      const consumed = optionValue(args, index, option);
      if (!consumed) return { ok: false, error: `${option} requires a value` };
      event[optionMap.get(option)!] = consumed.value;
      index = consumed.nextIndex;
    }
    return {
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.event,
      body: { session, event: compactRecord(event) },
    };
  }

  const simpleSessionRoutes: Record<string, string> = {
    "mark-seen": PROJECT_API_ROUTES.runtime.markSeen,
    "clear-log": PROJECT_API_ROUTES.runtime.clearLog,
  };
  if (subcommand in simpleSessionRoutes) {
    const session = args[1];
    if (!session || session.startsWith("-") || args.length !== 2) {
      return { ok: false, error: `metadata ${subcommand} requires <session>` };
    }
    return { ok: true, command: "post", routePath: simpleSessionRoutes[subcommand], body: { session } };
  }

  if (subcommand === "set-activity" || subcommand === "set-attention") {
    const session = args[1];
    const value = args[2];
    if (!session || !value || session.startsWith("-") || value.startsWith("-") || args.length !== 3) {
      return { ok: false, error: `metadata ${subcommand} requires <session> and <value>` };
    }
    const key = subcommand === "set-activity" ? "activity" : "attention";
    const routePath =
      subcommand === "set-activity" ? PROJECT_API_ROUTES.runtime.setActivity : PROJECT_API_ROUTES.runtime.setAttention;
    return { ok: true, command: "post", routePath, body: { session, [key]: value } };
  }

  if (subcommand === "set-status") {
    const session = args[1];
    const text = args[2];
    if (!session || !text || session.startsWith("-")) {
      return { ok: false, error: "metadata set-status requires <session> and <text>" };
    }
    let tone = "info";
    for (let index = 3; index < args.length; index += 1) {
      const consumed = optionValue(args, index, "--tone");
      if (!consumed) return { ok: false, error: `unsupported metadata set-status argument: ${args[index]}` };
      tone = consumed.value;
      index = consumed.nextIndex;
    }
    return {
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.setStatus,
      body: { session, text, tone },
    };
  }

  if (subcommand === "set-progress") {
    const session = args[1];
    const current = Number(args[2]);
    const total = Number(args[3]);
    if (!session || session.startsWith("-") || !Number.isFinite(current) || !Number.isFinite(total)) {
      return { ok: false, error: "metadata set-progress requires <session> <current> <total>" };
    }
    let label: string | undefined;
    for (let index = 4; index < args.length; index += 1) {
      const consumed = optionValue(args, index, "--label");
      if (!consumed) return { ok: false, error: `unsupported metadata set-progress argument: ${args[index]}` };
      label = consumed.value;
      index = consumed.nextIndex;
    }
    return {
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.setProgress,
      body: compactRecord({ session, current, total, label }),
    };
  }

  if (subcommand === "set-context") {
    const session = args[1];
    if (!session || session.startsWith("-")) return { ok: false, error: "metadata set-context requires <session>" };
    const optionMap = new Map([
      ["--cwd", "cwd"],
      ["--worktree-path", "worktreePath"],
      ["--worktree-name", "worktreeName"],
      ["--branch", "branch"],
      ["--pr-number", "prNumber"],
      ["--pr-title", "prTitle"],
      ["--pr-url", "prUrl"],
    ]);
    const values: Record<string, string> = {};
    for (let index = 2; index < args.length; index += 1) {
      const option = [...optionMap.keys()].find((name) => args[index] === name || args[index].startsWith(`${name}=`));
      if (!option) return { ok: false, error: `unsupported metadata set-context argument: ${args[index]}` };
      const consumed = optionValue(args, index, option);
      if (!consumed) return { ok: false, error: `${option} requires a value` };
      values[optionMap.get(option)!] = consumed.value;
      index = consumed.nextIndex;
    }
    const context: Record<string, unknown> = compactRecord({
      cwd: values.cwd,
      worktreePath: values.worktreePath,
      worktreeName: values.worktreeName,
      branch: values.branch,
    });
    if (values.prNumber || values.prTitle || values.prUrl) {
      context.pr = compactRecord({
        number: values.prNumber ? Number(values.prNumber) : undefined,
        title: values.prTitle,
        url: values.prUrl,
      });
    }
    return { ok: true, command: "post", routePath: PROJECT_API_ROUTES.runtime.setContext, body: { session, context } };
  }

  if (subcommand === "set-services") {
    const session = args[1];
    if (!session || session.startsWith("-")) return { ok: false, error: "metadata set-services requires <session>" };
    const urls: string[] = [];
    let label: string | undefined;
    for (let index = 2; index < args.length; index += 1) {
      const arg = args[index];
      const labelValue = optionValue(args, index, "--label");
      if (labelValue) {
        label = labelValue.value;
        index = labelValue.nextIndex;
        continue;
      }
      const inlineUrl = arg.startsWith("--url=") ? arg.slice("--url=".length) : "";
      if (inlineUrl) {
        urls.push(inlineUrl);
        continue;
      }
      if (arg !== "--url") return { ok: false, error: `unsupported metadata set-services argument: ${arg}` };
      let consumed = false;
      while (args[index + 1] && !args[index + 1].startsWith("--")) {
        urls.push(args[index + 1]);
        index += 1;
        consumed = true;
      }
      if (!consumed) return { ok: false, error: "--url requires a value" };
    }
    if (urls.length === 0) return { ok: false, error: "metadata set-services requires --url" };
    const services = urls.map((url) => {
      const match = url.match(/:(\d+)(?:\/|$)/);
      return compactRecord({ label, url, port: match ? Number(match[1]) : undefined });
    });
    return {
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.setServices,
      body: { session, services },
    };
  }

  if (subcommand === "log") {
    const session = args[1];
    const message = args[2];
    if (!session || !message || session.startsWith("-"))
      return { ok: false, error: "metadata log requires <session> <message>" };
    let source: string | undefined;
    let tone: string | undefined;
    for (let index = 3; index < args.length; index += 1) {
      const sourceValue = optionValue(args, index, "--source");
      if (sourceValue) {
        source = sourceValue.value;
        index = sourceValue.nextIndex;
        continue;
      }
      const toneValue = optionValue(args, index, "--tone");
      if (toneValue) {
        tone = toneValue.value;
        index = toneValue.nextIndex;
        continue;
      }
      return { ok: false, error: `unsupported metadata log argument: ${args[index]}` };
    }
    return {
      ok: true,
      command: "post",
      routePath: PROJECT_API_ROUTES.runtime.log,
      body: compactRecord({ session, message, source, tone }),
    };
  }

  return { ok: false, error: "unsupported metadata command" };
}
