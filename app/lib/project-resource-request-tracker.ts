import {
  isCurrentProjectResourceRequest,
  projectResourceRequestKey,
  type ProjectResourceRequestScope,
} from "@/stores/project";

export interface ProjectResourceRequestMarker {
  seq: number;
  requestKey: string;
  scope: ProjectResourceRequestScope;
}

export function createProjectResourceRequestTracker(initialScope: {
  endpointKey: string | null;
  projectPath: string;
}) {
  let seq = 0;
  let generation = 0;
  let currentScope: ProjectResourceRequestScope = {
    ...initialScope,
    generation,
  };

  return {
    update(scope: { endpointKey: string | null; projectPath: string }) {
      generation += 1;
      currentScope = {
        ...scope,
        generation,
      };
    },
    begin(): ProjectResourceRequestMarker {
      seq += 1;
      return {
        seq,
        requestKey: projectResourceRequestKey(currentScope),
        scope: currentScope,
      };
    },
    invalidate() {
      seq += 1;
    },
    invalidateGeneration() {
      seq += 1;
      generation += 1;
      currentScope = {
        ...currentScope,
        generation,
      };
    },
    isCurrent(marker: ProjectResourceRequestMarker): boolean {
      return marker.seq === seq && isCurrentProjectResourceRequest(marker.scope, currentScope);
    },
  };
}
