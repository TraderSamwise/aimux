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
): Promise<string | null> {
  try {
    await clearOperationFailures(endpoint, {}, { token });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/// Everything the button does, with the component's state handed in.
///
/// Not a convenience: this harness calls components as functions and has no
/// DOM, so hooks cannot run and nothing can press a rendered control. An
/// adversarial review of PR 406 made the point concretely -- with the sequence
/// inlined in the shell, fifteen mutations survived the whole suite, including
/// deleting the in-flight guard, never clearing it again, dropping the refresh
/// and swallowing the error. All of that is reachable here.
export async function runOperationFailureDismiss(
  endpoint: ServiceEndpoint | null,
  token: string | null,
  io: {
    inFlight: () => boolean;
    setInFlight: (value: boolean) => void;
    setDismissing: (value: boolean) => void;
    setError: (message: string | null) => void;
    refresh: () => void;
  },
): Promise<void> {
  if (!endpoint || io.inFlight()) return;
  io.setInFlight(true);
  try {
    io.setDismissing(true);
    io.setError(null);
    // The request's answer, as a value. It used to be two callbacks invoked
    // INSIDE the catch's reach, so a throw from the refresh was caught and
    // reported as "Could not dismiss" -- on a dismiss the server had already
    // carried out.
    const failure = await dismissOperationFailures(endpoint, token);
    if (failure !== null) {
      io.setError(failure);
    } else {
      try {
        io.refresh();
      } catch (e) {
        // Said, and said as what it is. Routing this to "Could not dismiss"
        // blamed the wrong half of the work, and letting it escape -- which an
        // earlier draft did -- made it an unhandled rejection out of `onPress`
        // with nothing on screen at all.
        io.setError(
          `Dismissed, but the view did not refresh: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    // Always, or a throw anywhere above leaves the button disabled and reading
    // "Dismissing..." with nothing able to put it back.
    io.setInFlight(false);
    io.setDismissing(false);
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
  endpoint,
  className,
}: {
  summary: { title: string; detail: string };
  error: string | null;
  dismissing: boolean;
  onDismiss: () => void;
  // Whether there is a host to ask at all. The decision lives here rather than
  // in the shell because the shell cannot be rendered by this harness, and a
  // Dismiss that quietly does nothing is the affordance this card exists to
  // stop telling.
  endpoint: ServiceEndpoint | null;
  className?: string;
}) {
  return (
    <PageStateCard
      className={className}
      title={summary.title}
      body={[summary.detail, error && `Could not dismiss: ${error}`].filter(Boolean).join("\n")}
      tone="warning"
      action={
        endpoint ? (
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
    await runOperationFailureDismiss(endpoint, token, {
      inFlight: () => inFlight.current,
      setInFlight: (value) => {
        inFlight.current = value;
      },
      setDismissing,
      setError,
      refresh: () => {
        kickDesktopRefresh();
        kickProjectViewRefresh(["worktrees", "topology"]);
      },
    });
  }

  return (
    <OperationFailureCardView
      className={className}
      summary={summary}
      error={error}
      dismissing={dismissing}
      onDismiss={dismiss}
      endpoint={endpoint}
    />
  );
}
