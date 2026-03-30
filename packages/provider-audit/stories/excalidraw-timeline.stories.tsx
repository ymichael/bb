import type { Story } from "@ladle/react";
import {
  ConversationTimeline,
  ThreadTimelineRows,
} from "@bb/ui-core";
import { fixtureStoryData } from "../.ladle/fixture-story-data";

const EMPTY_LOADING_IDS = new Set<string>();
const EMPTY_TOOL_GROUP_MESSAGES: Record<string, never[]> = {};

type FixtureStoryId = string;

function findFixture(fixtureId: FixtureStoryId) {
  const fixture = fixtureStoryData.fixtures.find((candidate) => candidate.id === fixtureId);
  if (!fixture) {
    throw new Error(`Missing fixture story data for ${fixtureId}`);
  }
  return fixture;
}

function FixtureTimeline({ fixtureId }: { fixtureId: FixtureStoryId }) {
  const fixture = findFixture(fixtureId);

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 px-6 py-8">
      <header className="space-y-1 rounded-md border border-border/70 bg-card/60 px-4 py-3">
        <p className="font-mono ui-text-xs text-muted-foreground">
          {fixture.providerId} / {fixture.taskId}
        </p>
        <h1 className="text-lg font-semibold text-foreground">{fixture.scenarioDescription}</h1>
        <p className="text-sm text-muted-foreground">
          {fixture.viewMessageCount} messages across {fixture.timelineRowCount} rows
        </p>
      </header>
      <ConversationTimeline className="gap-2">
        <ThreadTimelineRows
          latestActivityRowId={fixture.latestActivityRowId}
          loadingToolGroupIds={EMPTY_LOADING_IDS}
          onLoadToolGroupMessages={() => {}}
          themeType="dark"
          threadDetailRows={fixture.timelineRows}
          threadStatus={fixture.threadStatus}
          toolGroupMessagesById={EMPTY_TOOL_GROUP_MESSAGES}
        />
      </ConversationTimeline>
    </div>
  );
}

export default {
  title: "Excalidraw Timeline",
};

function createFixtureStory(fixtureId: FixtureStoryId): Story {
  return () => <FixtureTimeline fixtureId={fixtureId} />;
}

export const ClaudeCodeExplanation = createFixtureStory(
  "excalidraw/claude-code/ttd-explanation",
);
export const ClaudeCodeFeature = createFixtureStory(
  "excalidraw/claude-code/search-feature",
);
export const ClaudeCodeBugfix = createFixtureStory(
  "excalidraw/claude-code/search-bugfix",
);
export const ClaudeCodeCollabStartupExplanation = createFixtureStory(
  "excalidraw/claude-code/collab-startup-explanation",
);
export const ClaudeCodeEyedropperPreviewBugfix = createFixtureStory(
  "excalidraw/claude-code/eyedropper-preview-bugfix",
);
export const ClaudeCodeMagicframeFeature = createFixtureStory(
  "excalidraw/claude-code/magicframe-feature",
);
export const ClaudeCodeEyedropperBrowserCompat = createFixtureStory(
  "excalidraw/claude-code/eyedropper-browser-compat",
);

export const CodexExplanation = createFixtureStory(
  "excalidraw/codex/ttd-explanation",
);
export const CodexFeature = createFixtureStory(
  "excalidraw/codex/search-feature",
);
export const CodexBugfix = createFixtureStory(
  "excalidraw/codex/search-bugfix",
);
export const CodexCollabStartupExplanation = createFixtureStory(
  "excalidraw/codex/collab-startup-explanation",
);
export const CodexEyedropperPreviewBugfix = createFixtureStory(
  "excalidraw/codex/eyedropper-preview-bugfix",
);
export const CodexMagicframeFeature = createFixtureStory(
  "excalidraw/codex/magicframe-feature",
);
export const CodexShareWebCompat = createFixtureStory(
  "excalidraw/codex/share-web-compat",
);

export const PiExplanation = createFixtureStory(
  "excalidraw/pi/ttd-explanation",
);
export const PiFeature = createFixtureStory(
  "excalidraw/pi/search-feature",
);
export const PiBugfix = createFixtureStory(
  "excalidraw/pi/search-bugfix",
);
export const PiCollabStartupExplanation = createFixtureStory(
  "excalidraw/pi/collab-startup-explanation",
);
export const PiEyedropperPreviewBugfix = createFixtureStory(
  "excalidraw/pi/eyedropper-preview-bugfix",
);
export const PiMagicframeFeature = createFixtureStory(
  "excalidraw/pi/magicframe-feature",
);
export const PiCommandPaletteMap = createFixtureStory(
  "excalidraw/pi/command-palette-map",
);
