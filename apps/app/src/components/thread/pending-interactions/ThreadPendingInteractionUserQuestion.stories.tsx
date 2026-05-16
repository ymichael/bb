import type { PendingInteraction } from "@bb/domain";
import { ThreadPendingInteractionBanner } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "thread/Pending Interaction/User Question",
};

interface PromptStageProps {
  children: React.ReactNode;
}

function PromptStage({ children }: PromptStageProps) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

function basePendingInteraction(): Omit<PendingInteraction, "payload"> {
  return {
    id: "pi_question_demo",
    threadId: "thr_qfk8ksbxkk",
    turnId: "turn_demo",
    providerId: "claude-code",
    providerThreadId: "provider-thread-demo",
    providerRequestId: "request-demo",
    status: "pending",
    resolution: null,
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

const singleQuestion: PendingInteraction = {
  ...basePendingInteraction(),
  payload: {
    kind: "user_question",
    questions: [
      {
        id: "path",
        prompt: "Which implementation path should I take?",
        shortLabel: "Path",
        multiSelect: false,
        options: [
          {
            value: "small",
            label: "Small patch",
            description: "Fix the active issue with minimal churn.",
          },
          {
            value: "complete",
            label: "Complete flow",
            description: "Update UI, CLI, tests, and stories together.",
          },
        ],
        allowFreeText: true,
      },
    ],
  },
};

const multiQuestion: PendingInteraction = {
  ...basePendingInteraction(),
  id: "pi_question_multi_demo",
  payload: {
    kind: "user_question",
    questions: [
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
    ],
  },
};

const resolvingQuestion: PendingInteraction = {
  ...singleQuestion,
  id: "pi_question_resolving_demo",
  status: "resolving",
  resolution: {
    kind: "user_answer",
    answers: {
      path: {
        selected: ["complete"],
        freeText: "Keep the contract changes explicit.",
      },
    },
  },
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="single question"
        hint="one selectable answer with optional free text"
      >
        <PromptStage>
          <ThreadPendingInteractionBanner
            interaction={singleQuestion}
            threadId={singleQuestion.threadId}
          />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="multi-question"
        hint="multiple questions must each be answered before submit"
      >
        <PromptStage>
          <ThreadPendingInteractionBanner
            interaction={multiQuestion}
            threadId={multiQuestion.threadId}
          />
        </PromptStage>
      </StoryRow>
      <StoryRow
        label="resolving"
        hint="answer submitted; provider resolution is in-flight"
      >
        <PromptStage>
          <ThreadPendingInteractionBanner
            interaction={resolvingQuestion}
            threadId={resolvingQuestion.threadId}
          />
        </PromptStage>
      </StoryRow>
    </StoryCard>
  );
}
