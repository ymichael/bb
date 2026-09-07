import { StoryCard, StoryRow } from "../../.ladle/story-card";
import {
  CompactHomePage,
  HOME_THREADS,
  PhoneFrame,
} from "./mobile-home-story-fixtures";

export default {
  title: "views/Compact Home",
};

export function Overview() {
  return (
    <StoryCard labelWidth="170px">
      <StoryRow
        label="composer pinned, recents scroll behind it"
        hint="393×852 with the real recents list. The composer is an overlay at the bottom; rows run underneath it and dissolve into a strong fade rather than stopping at a hard edge."
      >
        <PhoneFrame>
          <CompactHomePage />
        </PhoneFrame>
      </StoryRow>
      <StoryRow
        label="short list"
        hint="with only a few threads the list still rests above the composer instead of stretching to fill"
      >
        <PhoneFrame>
          <CompactHomePage threads={HOME_THREADS.slice(0, 3)} />
        </PhoneFrame>
      </StoryRow>
    </StoryCard>
  );
}
