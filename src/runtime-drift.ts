export function isAimuxBuildDriftError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("different local build");
}
