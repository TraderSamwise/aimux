export type TerminalQueryStrategy = "builtin" | "fallback" | "unsupported";

export interface TerminalQuerySupportEntry {
  id: string;
  family: "csi" | "osc";
  pattern: string;
  matcher: RegExp;
  strategy: TerminalQueryStrategy;
  notes: string;
}

export const DEFAULT_TERMINAL_QUERY_SUPPORT: TerminalQuerySupportEntry[] = [
  {
    id: "cursor-position-report",
    family: "csi",
    pattern: "CSI 6n",
    matcher: /^\x1b\[6n$/,
    strategy: "builtin",
    notes: "Replies with the compositor cursor position.",
  },
  {
    id: "device-attributes-primary",
    family: "csi",
    pattern: "CSI c",
    matcher: /^\x1b\[c$/,
    strategy: "builtin",
    notes: "Replies with VT100-with-advanced-video style attributes.",
  },
  {
    id: "kitty-keyboard-push",
    family: "csi",
    pattern: "CSI > Ps u",
    matcher: /^\x1b\[>\d*u$/,
    strategy: "builtin",
    notes: "Tracks per-session kitty keyboard enhancement flags.",
  },
  {
    id: "kitty-keyboard-query",
    family: "csi",
    pattern: "CSI ? u / CSI ? Ps u",
    matcher: /^\x1b\[\?\d*u$/,
    strategy: "builtin",
    notes: "Replies with the last observed kitty keyboard enhancement flags.",
  },
  {
    id: "foreground-color-query",
    family: "osc",
    pattern: "OSC 10 ; ?",
    matcher: /^\x1b\]10;\?(?:\x1b\\|\x07)$/,
    strategy: "builtin",
    notes: "Replies with the current foreground color in ST or BEL form.",
  },
  {
    id: "background-color-query",
    family: "osc",
    pattern: "OSC 11 ; ?",
    matcher: /^\x1b\]11;\?(?:\x1b\\|\x07)$/,
    strategy: "builtin",
    notes: "Replies with the current background color in ST or BEL form.",
  },
  {
    id: "cursor-color-query",
    family: "osc",
    pattern: "OSC 12 ; ?",
    matcher: /^\x1b\]12;\?(?:\x1b\\|\x07)$/,
    strategy: "builtin",
    notes: "Replies with the current cursor color in ST or BEL form.",
  },
  {
    id: "palette-color-query",
    family: "osc",
    pattern: "OSC 4 ; index ; ?",
    matcher: /^\x1b\]4;\d+;\?(?:\x1b\\|\x07)$/,
    strategy: "fallback",
    notes: "Allowed through the host fallback broker when focused and safe.",
  },
];

export function classifyTerminalQuery(
  query: string,
  entries: TerminalQuerySupportEntry[] = DEFAULT_TERMINAL_QUERY_SUPPORT,
): TerminalQuerySupportEntry | undefined {
  return entries.find((entry) => entry.matcher.test(query));
}
