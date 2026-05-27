export type RuntimeBrandId = "claude" | "codex" | "shell" | "service" | "unknown";

export interface RuntimeBrand {
  id: RuntimeBrandId;
  label: string;
  shortLabel: string;
  color: string;
  background: string;
}

const BRANDS: Record<RuntimeBrandId, RuntimeBrand> = {
  claude: {
    id: "claude",
    label: "Claude",
    shortLabel: "CL",
    color: "#f97316",
    background: "rgba(249, 115, 22, 0.14)",
  },
  codex: {
    id: "codex",
    label: "Codex",
    shortLabel: "CX",
    color: "#22c55e",
    background: "rgba(34, 197, 94, 0.14)",
  },
  shell: {
    id: "shell",
    label: "Shell",
    shortLabel: "SH",
    color: "#38bdf8",
    background: "rgba(56, 189, 248, 0.14)",
  },
  service: {
    id: "service",
    label: "Service",
    shortLabel: "SV",
    color: "#a78bfa",
    background: "rgba(167, 139, 250, 0.14)",
  },
  unknown: {
    id: "unknown",
    label: "Unknown",
    shortLabel: "??",
    color: "#a1a1aa",
    background: "rgba(161, 161, 170, 0.14)",
  },
};

export function runtimeBrandForCommand(
  command: string | undefined,
  fallback?: RuntimeBrandId,
): RuntimeBrand {
  const normalized = command?.trim().toLowerCase() ?? "";
  if (normalized.includes("claude")) return BRANDS.claude;
  if (normalized.includes("codex")) return BRANDS.codex;
  if (normalized.includes("bash") || normalized.includes("zsh") || normalized.includes("shell")) {
    return BRANDS.shell;
  }
  if (fallback) return BRANDS[fallback];
  return BRANDS.unknown;
}

export function runtimeBrandForKind(kind: "agent" | "service", command?: string): RuntimeBrand {
  return runtimeBrandForCommand(command, kind === "service" ? "service" : "unknown");
}
