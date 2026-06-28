import React from "react";
import { Redirect } from "expo-router";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";

function browserSearchValue(name: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get(name) ?? undefined;
}

export default function InboxAlias() {
  return (
    <Redirect
      href={buildViewHref("/notifications", {
        project: cleanSearchValue(browserSearchValue("project")),
        lens: cleanSearchValue(browserSearchValue("lens")),
      })}
    />
  );
}
