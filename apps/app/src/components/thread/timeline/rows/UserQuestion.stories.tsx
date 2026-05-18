import type { TimelineRow } from "@bb/server-contract";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/User Question",
};

interface TimelineStageProps {
  children: React.ReactNode;
}

interface QuestionRowOptions {
  answers?: TimelineQuestionRow["answers"];
  id: string;
  lifecycle: TimelineQuestionRow["lifecycle"];
  status: TimelineQuestionRow["status"];
  statusReason?: string | null;
}

type TimelineQuestionRow = Extract<TimelineRow, { workKind: "question" }>;
type TimelineRowsBaseProps = Omit<ThreadTimelineRowsProps, "timelineRows">;

function TimelineStage({ children }: TimelineStageProps) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps: TimelineRowsBaseProps = {
  loadingTurnSummaryIds: new Set<string>(),
  erroredTurnSummaryIds: new Set<string>(),
  onLoadTurnSummaryRows: () => {},
  threadRuntimeDisplayStatus: "idle",
  turnSummaryRowsIdentity: "story",
  turnSummaryRowsById: {},
  workspaceRootPath: undefined,
};

const questions: TimelineQuestionRow["questions"] = [
  {
    id: "scope",
    prompt: "Which areas should I update?",
    shortLabel: "Scope",
    multiSelect: true,
    options: [
      { value: "app", label: "App UI" },
      { value: "cli", label: "CLI" },
      { value: "tests", label: "Tests" },
    ],
    allowFreeText: false,
  },
  {
    id: "notes",
    prompt: "Anything else I should account for?",
    shortLabel: "Notes",
    multiSelect: false,
    allowFreeText: true,
  },
];

function questionRow({
  answers = null,
  id,
  lifecycle,
  status,
  statusReason = null,
}: QuestionRowOptions): TimelineQuestionRow {
  return {
    id,
    threadId: "thr_question_story",
    turnId: "turn_question_story",
    sourceSeqStart: 10,
    sourceSeqEnd: 10,
    startedAt: 1777340000000,
    createdAt: 1777340000000,
    kind: "work",
    workKind: "question",
    status,
    interactionId: "pi_question_story",
    lifecycle,
    questions,
    answers,
    statusReason,
  };
}

const pendingQuestion = questionRow({
  id: "thr_question_story:question:pending",
  lifecycle: "pending",
  status: "pending",
});

const resolvingQuestion = questionRow({
  id: "thr_question_story:question:resolving",
  lifecycle: "resolving",
  status: "pending",
  answers: {
    scope: {
      selected: ["app", "tests"],
    },
    notes: {
      selected: [],
      freeText: "Keep the banner as the actionable surface.",
    },
  },
});

const answeredQuestion = questionRow({
  id: "thr_question_story:question:answered",
  lifecycle: "answered",
  status: "completed",
  answers: {
    scope: {
      selected: ["app", "tests"],
    },
    notes: {
      selected: [],
      freeText: "Keep the banner as the actionable surface.",
    },
  },
});

const interruptedQuestion = questionRow({
  id: "thr_question_story:question:interrupted",
  lifecycle: "interrupted",
  status: "interrupted",
  statusReason: "The turn was interrupted before the question was answered.",
});

const expiredQuestion = questionRow({
  id: "thr_question_story:question:expired",
  lifecycle: "expired",
  status: "completed",
  statusReason: "Expired before an answer was submitted.",
});

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="pending"
        hint="status row only; the answer controls live in the pending banner"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[pendingQuestion]}
            initialExpanded={new Set([pendingQuestion.id])}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="resolving"
        hint="answer submitted; waiting for provider acknowledgement"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[resolvingQuestion]}
            initialExpanded={new Set([resolvingQuestion.id])}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow label="answered" hint="shows the recorded user response">
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[answeredQuestion]}
            initialExpanded={new Set([answeredQuestion.id])}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow label="interrupted" hint="turn stopped before answer delivery">
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[interruptedQuestion]}
            initialExpanded={new Set([interruptedQuestion.id])}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow label="expired" hint="question timed out unresolved">
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[expiredQuestion]}
            initialExpanded={new Set([expiredQuestion.id])}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
