import { atom } from "jotai";
import {
  monitorSessionTargetsForProject,
  monitorSharedTargets,
  targetMatchesSettings,
  type MonitorTarget,
} from "@/lib/monitor-targets";
import { desktopStateFamily } from "@/stores/desktopState";
import { acceptedSharedSessionsAtom, monitorSettingsAtom } from "@/stores/settings";
import { projectsAtom } from "@/stores/projects";

export const monitorTargetsAtom = atom<MonitorTarget[]>((get) => {
  const projects = get(projectsAtom);
  const projectTargets = projects.flatMap((project) =>
    monitorSessionTargetsForProject(project, get(desktopStateFamily(project.path))),
  );
  return [...projectTargets, ...monitorSharedTargets(get(acceptedSharedSessionsAtom))];
});

export const selectedMonitorTargetAtom = atom<MonitorTarget | null>((get) => {
  const settings = get(monitorSettingsAtom);
  return get(monitorTargetsAtom).find((target) => targetMatchesSettings(target, settings)) ?? null;
});
