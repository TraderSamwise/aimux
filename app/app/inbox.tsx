import React from "react";
import { Redirect, useLocalSearchParams } from "expo-router";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";

export default function InboxAlias() {
  const params = useLocalSearchParams<{
    project?: string | string[];
    machine?: string | string[];
    lens?: string | string[];
  }>();
  return (
    <Redirect
      href={buildViewHref("/notifications", {
        project: cleanSearchValue(params.project),
        machine: cleanSearchValue(params.machine),
        lens: cleanSearchValue(params.lens),
      })}
    />
  );
}
