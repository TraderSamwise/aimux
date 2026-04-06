import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getProjectStateDirFor } from "./paths.js";
import { getAimuxCliEntryPath } from "./claude-hooks.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function buildZshRc(): string {
  return [
    'if [ -f "$HOME/.zshrc" ]; then',
    '  source "$HOME/.zshrc"',
    "fi",
    'if [ -f "$AIMUX_SHELL_INTEGRATION_SCRIPT" ]; then',
    '  source "$AIMUX_SHELL_INTEGRATION_SCRIPT"',
    "fi",
    "",
  ].join("\n");
}

function buildZshIntegration(): string {
  return [
    "_aimux_report_shell_state() {",
    '  [ -n "$AIMUX_NODE_BIN" ] || return 0',
    '  [ -n "$AIMUX_CLI_ENTRY" ] || return 0',
    '  [ -n "$AIMUX_SESSION_ID" ] || return 0',
    '  [ -n "$AIMUX_PROJECT_ROOT" ] || return 0',
    '  "$AIMUX_NODE_BIN" "$AIMUX_CLI_ENTRY" shell-hook "$1" --session "$AIMUX_SESSION_ID" --project "$AIMUX_PROJECT_ROOT" --tool "$AIMUX_TOOL" >/dev/null 2>&1 || true',
    "}",
    "",
    "_aimux_preexec() {",
    "  _aimux_report_shell_state running",
    "}",
    "",
    "_aimux_precmd() {",
    "  _aimux_report_shell_state prompt",
    "}",
    "",
    "autoload -Uz add-zsh-hook 2>/dev/null || true",
    "if typeset -f add-zsh-hook >/dev/null 2>&1; then",
    "  add-zsh-hook preexec _aimux_preexec",
    "  add-zsh-hook precmd _aimux_precmd",
    "else",
    "  preexec_functions=(${preexec_functions[@]} _aimux_preexec)",
    "  precmd_functions=(${precmd_functions[@]} _aimux_precmd)",
    "fi",
    "",
  ].join("\n");
}

function buildBashRc(): string {
  return [
    'if [ -f "$HOME/.bashrc" ]; then',
    '  source "$HOME/.bashrc"',
    "fi",
    'if [ -f "$AIMUX_SHELL_INTEGRATION_SCRIPT" ]; then',
    '  source "$AIMUX_SHELL_INTEGRATION_SCRIPT"',
    "fi",
    "",
  ].join("\n");
}

function buildBashIntegration(): string {
  return [
    "_aimux_report_shell_state() {",
    '  [ -n "$AIMUX_NODE_BIN" ] || return 0',
    '  [ -n "$AIMUX_CLI_ENTRY" ] || return 0',
    '  [ -n "$AIMUX_SESSION_ID" ] || return 0',
    '  [ -n "$AIMUX_PROJECT_ROOT" ] || return 0',
    '  "$AIMUX_NODE_BIN" "$AIMUX_CLI_ENTRY" shell-hook "$1" --session "$AIMUX_SESSION_ID" --project "$AIMUX_PROJECT_ROOT" --tool "$AIMUX_TOOL" >/dev/null 2>&1 || true',
    "}",
    "",
    "_aimux_preexec_command() {",
    '  [ -n "$COMP_LINE" ] && return',
    "  _aimux_report_shell_state running",
    "}",
    "",
    "_aimux_prompt_command() {",
    "  _aimux_report_shell_state prompt",
    "}",
    "",
    "trap '_aimux_preexec_command' DEBUG",
    'if [ -n "$PROMPT_COMMAND" ]; then',
    '  PROMPT_COMMAND="_aimux_prompt_command; $PROMPT_COMMAND"',
    "else",
    '  PROMPT_COMMAND="_aimux_prompt_command"',
    "fi",
    "",
  ].join("\n");
}

export interface PreparedShellIntegration {
  shellPath: string;
  shellName: "zsh" | "bash";
  integrationScriptPath: string;
  rcPath: string;
}

export function prepareShellIntegration(
  projectRoot: string,
  shellPath = process.env.SHELL || "/bin/zsh",
): PreparedShellIntegration {
  const shellBase = basename(shellPath).toLowerCase();
  const shellName: "zsh" | "bash" = shellBase.includes("bash") ? "bash" : "zsh";
  const baseDir = join(getProjectStateDirFor(projectRoot), "shell-integration");
  ensureDir(baseDir);

  const integrationScriptPath = join(
    baseDir,
    shellName === "bash" ? "aimux-bash-integration.bash" : "aimux-zsh-integration.zsh",
  );
  const rcPath = join(baseDir, shellName === "bash" ? "aimux-bashrc" : ".zshrc");

  writeFileSync(integrationScriptPath, shellName === "bash" ? buildBashIntegration() : buildZshIntegration());
  writeFileSync(rcPath, shellName === "bash" ? buildBashRc() : buildZshRc());

  return {
    shellPath,
    shellName,
    integrationScriptPath,
    rcPath,
  };
}

export function wrapCommandWithShellIntegration(opts: {
  projectRoot: string;
  sessionId: string;
  tool: string;
  command: string;
  args: string[];
  shellPath?: string;
}): { command: string; args: string[] } {
  const prepared = prepareShellIntegration(opts.projectRoot, opts.shellPath);
  const envArgs = [
    `AIMUX_NODE_BIN=${process.execPath}`,
    `AIMUX_CLI_ENTRY=${getAimuxCliEntryPath()}`,
    `AIMUX_SESSION_ID=${opts.sessionId}`,
    `AIMUX_PROJECT_ROOT=${opts.projectRoot}`,
    `AIMUX_TOOL=${opts.tool}`,
    `AIMUX_SHELL_INTEGRATION_SCRIPT=${prepared.integrationScriptPath}`,
  ];
  const commandString = [opts.command, ...opts.args].map(shellQuote).join(" ");
  const shellArgs =
    prepared.shellName === "bash"
      ? [...envArgs, prepared.shellPath, "--rcfile", prepared.rcPath, "-ic", commandString]
      : [...envArgs, "ZDOTDIR=" + dirname(prepared.rcPath), prepared.shellPath, "-ic", commandString];

  return { command: "env", args: shellArgs };
}

export function wrapInteractiveShellWithIntegration(opts: {
  projectRoot: string;
  sessionId: string;
  tool: string;
  shellPath?: string;
}): { command: string; args: string[] } {
  const prepared = prepareShellIntegration(opts.projectRoot, opts.shellPath);
  const envArgs = [
    `AIMUX_NODE_BIN=${process.execPath}`,
    `AIMUX_CLI_ENTRY=${getAimuxCliEntryPath()}`,
    `AIMUX_SESSION_ID=${opts.sessionId}`,
    `AIMUX_PROJECT_ROOT=${opts.projectRoot}`,
    `AIMUX_TOOL=${opts.tool}`,
    `AIMUX_SHELL_INTEGRATION_SCRIPT=${prepared.integrationScriptPath}`,
  ];
  const shellArgs =
    prepared.shellName === "bash"
      ? [...envArgs, prepared.shellPath, "--rcfile", prepared.rcPath, "-i"]
      : [...envArgs, "ZDOTDIR=" + dirname(prepared.rcPath), prepared.shellPath, "-i"];
  return { command: "env", args: shellArgs };
}
