import { BranchPicker } from "./BranchPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Branch Picker",
};

const branches = [
  "origin/main",
  "origin/develop",
  "origin/staging",
  "bb/feat/review-flow",
  "bb/fix/timeline-pagination",
  "bb/implement-server-daemon-protocol-simplification-thr_qfk8ksbxkk",
] as const;

const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default" hint="form-style, full-width">
        <BranchPicker value="origin/main" options={branches} onChange={noop} />
      </StoryRow>
      <StoryRow label="minimal" hint='variant="minimal"'>
        <BranchPicker
          value="origin/main"
          options={branches}
          variant="minimal"
          onChange={noop}
        />
      </StoryRow>
      <StoryRow label="minimal + muted" hint="prompt-box context">
        <BranchPicker
          value="origin/main"
          options={branches}
          variant="minimal"
          muted
          onChange={noop}
        />
      </StoryRow>
      <StoryRow label="loading">
        <BranchPicker
          value="origin/main"
          options={branches}
          loading
          onChange={noop}
        />
      </StoryRow>
      <StoryRow label="disabled">
        <BranchPicker
          value="origin/main"
          options={branches}
          disabled
          onChange={noop}
        />
      </StoryRow>
      <StoryRow
        label="open popover"
        hint="defaultOpen + modal=false + create-new affordance"
      >
        <BranchPicker
          value="origin/main"
          options={branches}
          onChange={noop}
          onCreate={noop}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
