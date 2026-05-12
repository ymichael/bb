import {
  ThreadEnvironmentPromotionDialogContent,
  type ThreadEnvironmentPromotionDialogTarget,
} from "./ThreadEnvironmentPromotionDialog";
import { BRANCH_NAMES } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Thread Environment Promotion",
};

const noop = () => {};
const asyncNoop = async () => {};

// Matches the dialog's custom DialogContent className: p-0 + tight border +
// 32rem width, leaving the header/form to own their own padding.
const stageClassName =
  "max-w-[32rem] gap-0 overflow-hidden border-border/80 p-0 shadow-xl";

const promoteTarget: ThreadEnvironmentPromotionDialogTarget = { kind: "promote" };
const demoteTarget: ThreadEnvironmentPromotionDialogTarget = { kind: "demote" };

const PRIMARY_CHECKOUT_PATH = "/Users/michael/Projects/bb";

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="promote"
        hint="standard promote — no blockers, submit enabled"
      >
        <DialogStage className={stageClassName}>
          <ThreadEnvironmentPromotionDialogContent
            target={promoteTarget}
            agentActive={false}
            blockers={[]}
            branchName={BRANCH_NAMES.feature}
            defaultBranch={BRANCH_NAMES.default}
            primaryCheckoutPath={PRIMARY_CHECKOUT_PATH}
            pending={false}
            onOpenChange={noop}
            onSubmit={asyncNoop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="demote"
        hint="planned-change copy moves the branch back to its worktree"
      >
        <DialogStage className={stageClassName}>
          <ThreadEnvironmentPromotionDialogContent
            target={demoteTarget}
            agentActive={false}
            blockers={[]}
            branchName={BRANCH_NAMES.feature}
            defaultBranch={BRANCH_NAMES.default}
            primaryCheckoutPath={PRIMARY_CHECKOUT_PATH}
            pending={false}
            onOpenChange={noop}
            onSubmit={asyncNoop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="agent active"
        hint="agent is running — submit disabled with a top-of-issues item"
      >
        <DialogStage className={stageClassName}>
          <ThreadEnvironmentPromotionDialogContent
            target={promoteTarget}
            agentActive
            blockers={[]}
            branchName={BRANCH_NAMES.feature}
            defaultBranch={BRANCH_NAMES.default}
            primaryCheckoutPath={PRIMARY_CHECKOUT_PATH}
            pending={false}
            onOpenChange={noop}
            onSubmit={asyncNoop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="blockers"
        hint="primary checkout dirty + local host disconnected — submit disabled"
      >
        <DialogStage className={stageClassName}>
          <ThreadEnvironmentPromotionDialogContent
            target={promoteTarget}
            agentActive={false}
            blockers={["primary_checkout_dirty", "local_host_disconnected"]}
            branchName={BRANCH_NAMES.feature}
            defaultBranch={BRANCH_NAMES.default}
            primaryCheckoutPath={PRIMARY_CHECKOUT_PATH}
            pending={false}
            onOpenChange={noop}
            onSubmit={asyncNoop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="pending"
        hint="submission in flight — submit shows a spinner"
      >
        <DialogStage className={stageClassName}>
          <ThreadEnvironmentPromotionDialogContent
            target={promoteTarget}
            agentActive={false}
            blockers={[]}
            branchName={BRANCH_NAMES.feature}
            defaultBranch={BRANCH_NAMES.default}
            primaryCheckoutPath={PRIMARY_CHECKOUT_PATH}
            pending
            onOpenChange={noop}
            onSubmit={asyncNoop}
          />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="minimal details"
        hint="no branch / no checkout path — rows collapse, only Planned change shows"
      >
        <DialogStage className={stageClassName}>
          <ThreadEnvironmentPromotionDialogContent
            target={promoteTarget}
            agentActive={false}
            blockers={[]}
            branchName={null}
            defaultBranch={null}
            pending={false}
            onOpenChange={noop}
            onSubmit={asyncNoop}
          />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
