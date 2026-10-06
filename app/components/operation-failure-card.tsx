import React, { useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { Button } from "@/components/ui/button";
import { PageStateCard } from "@/components/PageLayout";
import { clearOperationFailures } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

/// What the app sends to make a failed operation go away, and what it does
/// with either answer.
///
/// An EMPTY match, which is what the TUI's own `X` posts: the route reads every
/// field as optional, so no field means every ledger entry plus every worktree
/// row carrying a failure of its own, and the row's copy never expires.
///
/// Every error reaches `failed`, unfiltered. `isTransientRequestError` matches
/// "failed to fetch", so running this through it would have made the host being
/// gone -- the one case worth saying out loud -- a pressed button that did
/// nothing and said nothing.
export async function dismissOperationFailures(
  endpoint: ServiceEndpoint,
  token: string | null,
  sink: { cleared: () => void; failed: (message: string) => void },
): Promise<void> {
  try {
    await clearOperationFailures(endpoint, {}, { token });
    sink.cleared();
  } catch (e) {
    sink.failed(e instanceof Error ? e.message : String(e));
  }
}

/// The failed-operations card without the state, so it can be rendered.
///
/// The app's test harness calls components as functions and has no DOM, so a
/// component holding hooks cannot be rendered at all. The shell below owns the
/// hooks; everything a person sees or presses is here.
export function OperationFailureCardView({
  summary,
  error,
  dismissing,
  onDismiss,
  className,
}: {
  summary: { title: string; detail: string };
  error: string | null;
  dismissing: boolean;
  onDismiss: (() => void) | null;
  className?: string;
}) {
  return (
    <PageStateCard
      className={className}
      title={summary.title}
      body={[summary.detail, error && `Could not dismiss: ${error}`].filter(Boolean).join("\n")}
      tone="warning"
      action={
        onDismiss ? (
          <Button
            variant="outline"
            size="sm"
            accessibilityLabel="Dismiss failed operations"
            disabled={dismissing}
            label={dismissing ? "Dismissing..." : "Dismiss"}
            onPress={onDismiss}
          />
        ) : null
      }
    />
  );
}

/// The failed-operations card, with the dismiss the app never had.
///
/// The TUI has cleared these with `X` since it shipped; here the only exit was
/// the ledger's own expiry, so a red card outlived whatever it was about and
/// nothing on screen said how to make it go.
export function OperationFailureCard({
  summary,
  endpoint,
  token,
  className,
}: {
  summary: { title: string; detail: string };
  endpoint: ServiceEndpoint | null;
  token: string | null;
  className?: string;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not the `dismissing` state: `disabled` only reaches the control on
  // the next render, so two taps inside one frame both read false and both
  // post.
  const inFlight = useRef(false);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);

  async function dismiss() {
    if (!endpoint || inFlight.current) return;
    inFlight.current = true;
    setDismissing(true);
    setError(null);
    await dismissOperationFailures(endpoint, token, {
      cleared: () => {
        kickDesktopRefresh();
        kickProjectViewRefresh(["worktrees", "topology"]);
      },
      failed: setError,
    });
    inFlight.current = false;
    setDismissing(false);
  }

  return (
    <OperationFailureCardView
      className={className}
      summary={summary}
      error={error}
      dismissing={dismissing}
      onDismiss={endpoint ? dismiss : null}
    />
  );
}
