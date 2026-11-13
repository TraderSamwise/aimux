import React from "react";
import { projectNameFromPath, type UnresolvedSelection } from "@/lib/project-key";
import { useAtomValue } from "jotai";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { WorktreeDashboard } from "@/components/WorktreeDashboard";
import {
  isRelayUnavailableForProjectDiscovery,
  relayUnavailableProjectCopy,
} from "@/lib/project-connection-display";
import { useRouteProject } from "@/lib/use-route-project";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";

function EmptyCard({ title, body }: { title: string; body: string }) {
  return <PageStateCard title={title} body={body} />;
}

// The three reasons a selection can be unresolved, as three different things
// to tell the user. They were two, and a machineless ref took the "gone" one.
interface EmptyCardCopy {
  title: string;
  body: string;
}

function unresolvedSelectionCopy(selection: UnresolvedSelection): EmptyCardCopy {
  const { ref, reason } = selection;
  if (reason === "host-quiet") {
    return {
      // A machineless ref has no host to name -- it reaches here when nothing
      // in the snapshot has the path at all.
      title: ref.machineId ? `Waiting for ${ref.machineId}` : "Waiting for this project's host",
      body: `${ref.path} is the project you had open. It will load when its host answers; pick another from the sidebar to move on.`,
    };
  }
  if (reason === "ambiguous") {
    return {
      title: "More than one machine has this path",
      body: `${ref.path} exists on several of your machines, so this needs picking by host. Choose it from the sidebar.`,
    };
  }
  return {
    title: "Project not found",
    body: `${ref.path} is the project you had open, and its host no longer has it. Pick another from the sidebar.`,
  };
}

/**
 * The project's dashboard.
 *
 * This screen used to carry seven sections of its own beside the dashboard it
 * hosts. The counts repeated the topology screen's; the artifact and test
 * sections were a regular expression over story titles rather than anything
 * the service had classified; and the activity feed and the open queue sat two
 * screens away from the coordination worklist that asks the same question.
 * They are on coordination now, and this screen is the dashboard it always
 * was.
 *
 * It holds no resource of its own any more: `WorktreeDashboard` renders live
 * desktop state, so there is nothing here to poll, refresh, or fail.
 */
export default function ProjectScreen() {
  const { project, projectPath, endpoint, projectLoading, unresolvedSelection } = useRouteProject();
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const showRelayUnavailable =
    !project &&
    Boolean(projectPath) &&
    relayConfigured &&
    isRelayUnavailableForProjectDiscovery(relayStatus);
  const relayUnavailableCopy = relayUnavailableProjectCopy(relayStatus);

  return (
    <Page>
      <PageHeader
        eyebrow="Project"
        title={
          project?.name ??
          (projectLoading
            ? "Loading project..."
            : showRelayUnavailable
              ? relayUnavailableCopy.title.replace(/\.$/, "")
              : // A selection whose host has not answered is still a
                // selection, so it is named rather than denied.
                ((unresolvedSelection && projectNameFromPath(unresolvedSelection.ref.path)) ??
                "No project selected"))
        }
        subtitle={
          project?.path ??
          (projectLoading || showRelayUnavailable || unresolvedSelection
            ? (projectPath ?? unresolvedSelection?.ref.path)
            : undefined)
        }
      />

      {showRelayUnavailable ? (
        <EmptyCard title={relayUnavailableCopy.title} body={relayUnavailableCopy.detail} />
      ) : projectLoading ? (
        <EmptyCard title="Loading project..." body="Fetching project state from the daemon." />
      ) : unresolvedSelection ? (
        // Before this branch existed, the project Sam left on a machine that
        // had not answered read as "No project selected" -- while that
        // machine's projects were simply missing from the list, and the others
        // sat in the sidebar beside the message.
        //
        // `hostIsListed` is the difference between quiet and gone: a machine
        // that IS in this snapshot has answered and does not have the path, so
        // telling the user to wait for it would be waiting forever.
        <EmptyCard
          title={unresolvedSelectionCopy(unresolvedSelection).title}
          body={unresolvedSelectionCopy(unresolvedSelection).body}
        />
      ) : !project ? (
        <EmptyCard title="No project selected" body="Pick a project from the sidebar." />
      ) : !endpoint ? (
        <EmptyCard
          title="Project host offline"
          body="Start the project host to load project state."
        />
      ) : null}

      {project && endpoint ? <WorktreeDashboard padded={false} /> : null}
    </Page>
  );
}
