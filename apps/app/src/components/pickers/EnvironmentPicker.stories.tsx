import { EnvironmentPicker } from "./EnvironmentPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/pickers/Environment Picker",
};

const noop = () => {};

/**
 * EnvironmentPicker depends on live runtime state — it reads from jotai
 * atoms (sandboxHostSupportedAtom) and React Query hooks (useEffectiveHosts,
 * useSandboxBackends). Without a server, those hooks resolve to empty arrays.
 *
 * The picker is still informative in the story: the trigger button and label
 * fall back to "Sandbox" / "Unknown" / etc., and we can show the muted
 * vs default treatment.
 */
export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="default" hint="no live data — empty state">
        <EnvironmentPicker
          value=""
          onChange={noop}
          projectId="proj_demo"
          sources={[]}
        />
      </StoryRow>
      <StoryRow label="muted" hint="prompt-box treatment">
        <EnvironmentPicker
          value=""
          onChange={noop}
          projectId="proj_demo"
          sources={[]}
          muted
        />
      </StoryRow>
    </StoryCard>
  );
}
