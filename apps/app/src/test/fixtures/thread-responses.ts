import type {
  ThreadResponse,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import { makeThreadWithRuntime } from "@bb/test-helpers/domain-fixtures";

type ThreadResponseOverrides = Omit<Partial<ThreadResponse>, "runtime"> & {
  runtime?: Partial<ThreadResponse["runtime"]>;
};
type ThreadTimelineResponseOverrides = Omit<
  Partial<ThreadTimelineResponse>,
  "timelinePage"
> & {
  timelinePage?: Partial<ThreadTimelineResponse["timelinePage"]>;
};

export function makeThreadResponse(
  overrides: ThreadResponseOverrides = {},
): ThreadResponse {
  const thread = makeThreadWithRuntime({ runtime: overrides.runtime });
  return {
    ...thread,
    activeBackgroundAgentCount: 0,
    canSpawnChild: true,
    queuedMessageCount: 0,
    ...overrides,
    runtime: thread.runtime,
  };
}

export function makeThreadTimelineResponse(
  overrides: ThreadTimelineResponseOverrides = {},
): ThreadTimelineResponse {
  const response: ThreadTimelineResponse = {
    rows: [],
    contextBoundarySeq: null,
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    maxSeq: 0,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
  return {
    ...response,
    ...overrides,
    timelinePage: { ...response.timelinePage, ...overrides.timelinePage },
  };
}
