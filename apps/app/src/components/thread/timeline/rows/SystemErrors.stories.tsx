import type { ReactNode } from "react";
import type {
  TimelineNonOperationSystemRow,
  TimelineRow,
} from "@bb/server-contract";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "@/components/thread/timeline";
import { systemRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/System",
};

type TimelineRowsStoryBaseProps = Omit<
  ThreadTimelineRowsProps,
  "initialExpanded" | "timelineRows"
>;

interface TimelineStageProps {
  children: ReactNode;
}

interface ErrorRowsPreviewProps {
  initialExpanded?: ReadonlySet<string>;
  rows: TimelineRow[];
}

function TimelineStage({ children }: TimelineStageProps) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

function ErrorRowsPreview({ initialExpanded, rows }: ErrorRowsPreviewProps) {
  return (
    <TimelineStage>
      <ThreadTimelineRows
        {...baseProps}
        initialExpanded={initialExpanded}
        timelineRows={rows}
      />
    </TimelineStage>
  );
}

const baseProps: TimelineRowsStoryBaseProps = {
  threadRuntimeDisplayStatus: "idle",
  workspaceRootPath: undefined,
};

const providerStreamReconnect: TimelineNonOperationSystemRow = systemRow({
  id: "thr_ggp8mmze2q:error:5951",
  threadId: "thr_ggp8mmze2q",
  turnId: "019e3439-7692-7691-832f-a015ebaa50f5",
  sourceSeqStart: 5951,
  sourceSeqEnd: 5951,
  startedAt: 1778992975767,
  createdAt: 1778992975767,
  systemKind: "reconnect",
  title: "Reconnecting... 5/5",
  detail:
    "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
  status: null,
});

const providerStreamFinalFailure: TimelineNonOperationSystemRow = systemRow({
  id: "thr_ggp8mmze2q:error:5952",
  threadId: "thr_ggp8mmze2q",
  turnId: "019e3439-7692-7691-832f-a015ebaa50f5",
  sourceSeqStart: 5952,
  sourceSeqEnd: 5952,
  startedAt: 1778992981527,
  createdAt: 1778992981527,
  systemKind: "error",
  title: "Provider error",
  detail:
    "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
  status: "error",
});

const providerChildProcessTimeout: TimelineNonOperationSystemRow = systemRow({
  id: "thr_5cs6d5h7gu:error:19450",
  threadId: "thr_5cs6d5h7gu",
  turnId: "019e343a-076f-7a62-ac98-fb36f984b881",
  sourceSeqStart: 19450,
  sourceSeqEnd: 19450,
  startedAt: 1778993228124,
  createdAt: 1778993228124,
  systemKind: "reconnect",
  title: "Reconnecting... 3/5",
  detail: "timeout waiting for child process to exit",
  status: null,
});

const providerOverloaded: TimelineNonOperationSystemRow = systemRow({
  id: "thr_s7nr8hdsyf:error:416",
  threadId: "thr_s7nr8hdsyf",
  turnId: "turn_725060f798c8497a_1",
  sourceSeqStart: 416,
  sourceSeqEnd: 416,
  startedAt: 1778871667729,
  createdAt: 1778871667729,
  systemKind: "error",
  title: "API Error: Overloaded",
  detail: null,
  status: "error",
});

const providerRateLimit: TimelineNonOperationSystemRow = systemRow({
  id: "thr_axe9q6zfcj:error:48",
  threadId: "thr_axe9q6zfcj",
  turnId: "turn_f7e4049aca264187_1",
  sourceSeqStart: 48,
  sourceSeqEnd: 48,
  startedAt: 1777934876290,
  createdAt: 1777934876290,
  systemKind: "error",
  title: "You've hit your limit · resets 7:50pm (America/Los_Angeles)",
  detail: null,
  status: "error",
});

const providerModelUnavailable: TimelineNonOperationSystemRow = systemRow({
  id: "thr_u3r2maxtsx:error:10",
  threadId: "thr_u3r2maxtsx",
  turnId: "turn_bc782e4115754eb2_1",
  sourceSeqStart: 10,
  sourceSeqEnd: 10,
  startedAt: 1777871877997,
  createdAt: 1777871877997,
  systemKind: "error",
  title: "Provider error",
  detail:
    "There's an issue with the selected model (opus-4.7). It may not exist or you may not have access to it. Run --model to pick a different model.",
  status: "error",
});

const systemTurnSubmitTooLarge: TimelineNonOperationSystemRow = systemRow({
  id: "thr_wu5sexdwxn:error:2307",
  threadId: "thr_wu5sexdwxn",
  turnId: null,
  sourceSeqStart: 2307,
  sourceSeqEnd: 2307,
  startedAt: 1778610066610,
  createdAt: 1778610066610,
  systemKind: "error",
  title: "Command turn.submit failed",
  detail: "Input exceeds the maximum length of 1048576 characters.",
  status: "error",
});

const systemThreadStartModuleMissing: TimelineNonOperationSystemRow = systemRow(
  {
    id: "thr_2twyaj9bbg:error:5",
    threadId: "thr_2twyaj9bbg",
    turnId: null,
    sourceSeqStart: 5,
    sourceSeqEnd: 5,
    startedAt: 1778565234271,
    createdAt: 1778565234271,
    systemKind: "error",
    title: "Command thread.start failed",
    detail:
      'Provider "claude-code" exited unexpectedly\n' +
      "stderr: node:internal/modules/esm/resolve:274\n" +
      "    throw new ERR_MODULE_NOT_FOUND(\n" +
      "          ^\n" +
      "\n" +
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/michael/Projects/bb/packages/domain/src/shared-types.js' imported from /Users/michael/Projects/bb/packages/domain/src/index.ts\n" +
      "    at finalizeResolution (node:internal/modules/esm/resolve:274:11)\n" +
      "    at moduleResolve (node:internal/modules/esm/resolve:859:10)\n" +
      "    at defaultResolve (node:internal/modules/esm/resolve:983:11)\n" +
      "    at ModuleLoader.defaultReso",
    status: "error",
  },
);

const providerStreamDisconnectRows: TimelineRow[] = [
  providerStreamReconnect,
  providerStreamFinalFailure,
];

const providerStreamFinalFailureExpanded = new Set<string>([
  providerStreamFinalFailure.id,
]);
const providerChildProcessTimeoutExpanded = new Set<string>([
  providerChildProcessTimeout.id,
]);
const providerModelUnavailableExpanded = new Set<string>([
  providerModelUnavailable.id,
]);
const systemTurnSubmitTooLargeExpanded = new Set<string>([
  systemTurnSubmitTooLarge.id,
]);
const systemThreadStartModuleMissingExpanded = new Set<string>([
  systemThreadStartModuleMissing.id,
]);

export function Errors() {
  return (
    <StoryCard>
      <StoryRow
        label="provider/error — reconnect then failure"
        hint="reconnect attempts collapse to one progress row; the final willRetry=false failure is a separate (error) row"
      >
        <ErrorRowsPreview
          initialExpanded={providerStreamFinalFailureExpanded}
          rows={providerStreamDisconnectRows}
        />
      </StoryRow>
      <StoryRow
        label="provider/error — child process timeout"
        hint="reconnect row titled by its progress; the host timeout is in the body"
      >
        <ErrorRowsPreview
          initialExpanded={providerChildProcessTimeoutExpanded}
          rows={[providerChildProcessTimeout]}
        />
      </StoryRow>
      <StoryRow
        label="provider/error — overloaded"
        hint="short message — used directly as the title, single non-expandable line"
      >
        <ErrorRowsPreview rows={[providerOverloaded]} />
      </StoryRow>
      <StoryRow
        label="provider/error — rate limit"
        hint="short message — used directly as the title, single non-expandable line"
      >
        <ErrorRowsPreview rows={[providerRateLimit]} />
      </StoryRow>
      <StoryRow
        label="provider/error — model unavailable"
        hint="message too long for a title — generic title, full error in the expandable body"
      >
        <ErrorRowsPreview
          initialExpanded={providerModelUnavailableExpanded}
          rows={[providerModelUnavailable]}
        />
      </StoryRow>
      <StoryRow
        label="system/error — turn.submit too large"
        hint="thread command failed before the turn could be submitted"
      >
        <ErrorRowsPreview
          initialExpanded={systemTurnSubmitTooLargeExpanded}
          rows={[systemTurnSubmitTooLarge]}
        />
      </StoryRow>
      <StoryRow
        label="system/error — thread.start crashed"
        hint="daemon command failure with stderr stack trace"
      >
        <ErrorRowsPreview
          initialExpanded={systemThreadStartModuleMissingExpanded}
          rows={[systemThreadStartModuleMissing]}
        />
      </StoryRow>
    </StoryCard>
  );
}
