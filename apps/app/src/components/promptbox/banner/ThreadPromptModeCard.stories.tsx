import { useState } from "react";
import type { ThreadTimelineActivePromptMode } from "@bb/domain";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { ThreadPromptModeCard } from "./ThreadPromptModeCard";

export default {
  title: "promptbox/banner/Prompt Mode Card",
};

type StageSize = "desktop" | "mobile";

function Stage({
  children,
  size,
}: {
  children: React.ReactNode;
  size: StageSize;
}) {
  return (
    <div
      data-promptbox-shell=""
      className={size === "desktop" ? "min-w-0 flex-1" : "w-[20rem] shrink-0"}
    >
      {children}
    </div>
  );
}

function ResponsiveStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full min-w-0 items-start gap-3 overflow-x-auto">
      <Stage size="desktop">{children}</Stage>
      <Stage size="mobile">{children}</Stage>
    </div>
  );
}

function ToggleablePromptModeCard({
  activePromptMode,
  initiallyExpanded = false,
  onExitPlanMode,
}: {
  activePromptMode: ThreadTimelineActivePromptMode | null;
  initiallyExpanded?: boolean;
  onExitPlanMode?: () => void;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return (
    <ThreadPromptModeCard
      activePromptMode={activePromptMode}
      isExpanded={expanded}
      onExitPlanMode={onExitPlanMode}
      onToggle={() => setExpanded((value) => !value)}
    />
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed"
        hint="active Claude Code plan mode indicator; prompt stays hidden"
      >
        <ResponsiveStage>
          <ToggleablePromptModeCard
            activePromptMode={{
              mode: "plan",
              providerId: "claude-code",
              prompt: "inspect the failing command before making changes",
            }}
            onExitPlanMode={() => {}}
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow label="expanded" hint="unfurled body shows full cleaned prompt">
        <ResponsiveStage>
          <ToggleablePromptModeCard
            activePromptMode={{
              mode: "plan",
              providerId: "claude-code",
              prompt:
                "inspect the failing command before making changes. Check the relevant timeline state, compare the provider-specific behavior, and explain the safest implementation path before editing.",
            }}
            initiallyExpanded
            onExitPlanMode={() => {}}
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow label="codex" hint="same banner for Codex plan mode">
        <ResponsiveStage>
          <ToggleablePromptModeCard
            activePromptMode={{
              mode: "plan",
              providerId: "codex",
              prompt: "review the merge conflicts and propose a fix plan",
            }}
            onExitPlanMode={() => {}}
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow label="inactive" hint="renders nothing without active mode">
        <ResponsiveStage>
          <ThreadPromptModeCard
            activePromptMode={null}
            isExpanded={false}
            onToggle={() => {}}
          />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}
