import type { TimelineRow } from "@bb/server-contract";
import {
  ThreadTimelineRows,
  type ThreadTimelineUnreadDividerPlacement,
} from "@/components/thread/timeline";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Unread Divider",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const THREAD_ID = "thr_threadUnreadDivider";
const TURN_PREFIX = "019dd000-0000-7000-aa00-00000000000";

function userRow(args: {
  seq: number;
  text: string;
  createdAt: number;
}): TimelineRow {
  return {
    id: `${THREAD_ID}:user:${args.seq}`,
    threadId: THREAD_ID,
    turnId: `${TURN_PREFIX}${args.seq}`,
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: args.createdAt,
    createdAt: args.createdAt,
    kind: "conversation",
    role: "user",
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    text: args.text,
    mentions: [],
    attachments: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
  };
}

function assistantRow(args: {
  seq: number;
  text: string;
  createdAt: number;
}): TimelineRow {
  return {
    id: `${THREAD_ID}:assistant:${args.seq}`,
    threadId: THREAD_ID,
    turnId: `${TURN_PREFIX}${args.seq - 1}`,
    sourceSeqStart: args.seq,
    sourceSeqEnd: args.seq,
    startedAt: args.createdAt,
    createdAt: args.createdAt,
    kind: "conversation",
    role: "assistant",
    text: args.text,
    attachments: null,
    turnRequest: null,
  };
}

const T0 = 1777337000000;
const MINUTE = 60_000;

const conversationRows: TimelineRow[] = [
  userRow({
    seq: 1,
    createdAt: T0,
    text: "Audit the FollowUpPromptBox for the same prop trims we did on the banner.",
  }),
  assistantRow({
    seq: 2,
    createdAt: T0 + MINUTE,
    text: "On it — I'll start with the optional fields and shim shapes and report back as a punch list.",
  }),
  userRow({
    seq: 3,
    createdAt: T0 + 2 * MINUTE,
    text: "Also include the queue API while you're in there.",
  }),
  assistantRow({
    seq: 4,
    createdAt: T0 + 3 * MINUTE,
    text: "Added. Here are the top three trims so far:\n\n1. `banner` can collapse to a `ReactNode | null` slot.\n2. `ComposerMentionsProps` shim can be dropped in favor of `MentionsConfig`.\n3. `provider.readOnly` is derivable from `!provider.onChange`.",
  }),
  userRow({
    seq: 5,
    createdAt: T0 + 4 * MINUTE,
    text: "Good. Keep going — I want at least seven before we cut the PR.",
  }),
  assistantRow({
    seq: 6,
    createdAt: T0 + 5 * MINUTE,
    text: "Four more landed. Full list with current/recommended shapes is ready for review.",
  }),
];

const afterCutoffPlacement: ThreadTimelineUnreadDividerPlacement = {
  kind: "after-cutoff",
  cutoffAt: T0 + 3 * MINUTE + 30_000,
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="after-cutoff"
        hint="typical case — read up to assistant reply, two new messages arrived"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={conversationRows}
            unreadDividerPlacement={afterCutoffPlacement}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}
