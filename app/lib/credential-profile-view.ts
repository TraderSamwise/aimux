import type { CredentialProfilesResponse } from "@/lib/api";

/**
 * What the credential profile panel should show.
 *
 * Four outcomes, and the first two are the ones worth keeping apart: a block
 * that could not be READ is not a machine with NO profiles. Collapsing them
 * would tell somebody their machine has no profiles configured when it may
 * have several it cannot parse -- and the switch would then look unavailable
 * rather than broken.
 */
export type CredentialProfileView =
  | { kind: "unreadable"; reason: string }
  | { kind: "loading" }
  | { kind: "none" }
  | {
      kind: "list";
      profiles: NonNullable<CredentialProfilesResponse["profiles"]>;
      active: string | null;
    };

/**
 * Takes no `pending` flag, deliberately. It had one and never read it: this
 * returns `loading` whenever there is no report, and whether a request is in
 * flight is the caller's business for a spinner rather than part of the
 * branch. A parameter the function ignores is a worse lie than one it does
 * not have.
 */
export function credentialProfileView(
  report: CredentialProfilesResponse | null,
): CredentialProfileView {
  if (report == null) return { kind: "loading" };
  const profiles = report.profiles;
  // ABSENT is unreadable; EMPTY is a machine with none. The route omits the
  // key entirely when it could not read the block, for exactly this reason.
  if (profiles == null) {
    return {
      kind: "unreadable",
      reason: report.error ?? "The credential profiles could not be read.",
    };
  }
  if (profiles.length === 0) return { kind: "none" };
  return { kind: "list", profiles, active: report.active ?? null };
}

/** The directories a profile switches, for one line of the row. */
export function profileDirectories(profile: {
  claudeConfigDir?: string | null;
  codexHome?: string | null;
}): string {
  return [profile.claudeConfigDir, profile.codexHome]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(", ");
}
