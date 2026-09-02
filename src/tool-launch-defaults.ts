import type { ToolConfig } from "./config.js";
import type { LaunchOverride } from "./shell-args.js";

export function defaultsLaunchOverride(tool: ToolConfig): LaunchOverride | undefined {
  const defaultArgs = tool.defaultArgs ?? [];
  const hasEnv = tool.defaultEnv && Object.keys(tool.defaultEnv).length > 0;
  if (defaultArgs.length === 0 && !hasEnv) return undefined;
  return {
    command: tool.command,
    args: [...tool.args, ...defaultArgs],
    env: hasEnv ? tool.defaultEnv : undefined,
  };
}

export function mergeToolLaunchDefaults(
  tool: ToolConfig,
  extraArgs: string[] = [],
  extraEnv?: Record<string, string>,
): LaunchOverride {
  const defaults = defaultsLaunchOverride(tool);
  return {
    command: tool.command,
    args: [...(defaults?.args ?? tool.args), ...extraArgs],
    env: { ...(defaults?.env ?? {}), ...(extraEnv ?? {}) },
  };
}
