import cursorIcon from "@/assets/workspace-open-target-icons/cursor.png";
import finderIcon from "@/assets/workspace-open-target-icons/finder.png";
import terminalIcon from "@/assets/workspace-open-target-icons/terminal.png";
import vscodeIcon from "@/assets/workspace-open-target-icons/vscode.png";
import zedIcon from "@/assets/workspace-open-target-icons/zed.png";
import { SplitButton, type SplitButtonAction } from "./split-button";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/Split Button",
};

const noop = () => {};

interface EditorIconProps {
  alt: string;
  src: string;
}

function EditorIcon({ src, alt }: EditorIconProps) {
  return (
    <img
      alt={alt}
      src={src}
      draggable={false}
      className="size-5 shrink-0 rounded-[3px]"
    />
  );
}

const commitAction: SplitButtonAction = {
  label: "Commit",
  onSelect: noop,
};

const gitSecondaries: SplitButtonAction[] = [
  { label: "Amend commit", onSelect: noop },
];

const openInVSCodeAction: SplitButtonAction = {
  label: "Open workspace in VS Code",
  onSelect: noop,
  content: <EditorIcon src={vscodeIcon} alt="VS Code" />,
};

const editorSecondaries: SplitButtonAction[] = [
  {
    label: "VS Code",
    onSelect: noop,
    content: (
      <>
        <EditorIcon src={vscodeIcon} alt="" />
        <span className="min-w-0 flex-1">VS Code</span>
      </>
    ),
  },
  {
    label: "Cursor",
    onSelect: noop,
    content: (
      <>
        <EditorIcon src={cursorIcon} alt="" />
        <span className="min-w-0 flex-1">Cursor</span>
      </>
    ),
  },
  {
    label: "Zed",
    onSelect: noop,
    content: (
      <>
        <EditorIcon src={zedIcon} alt="" />
        <span className="min-w-0 flex-1">Zed</span>
      </>
    ),
  },
  {
    label: "Finder",
    onSelect: noop,
    content: (
      <>
        <EditorIcon src={finderIcon} alt="" />
        <span className="min-w-0 flex-1">Finder</span>
      </>
    ),
  },
  {
    label: "Terminal",
    onSelect: noop,
    content: (
      <>
        <EditorIcon src={terminalIcon} alt="" />
        <span className="min-w-0 flex-1">Terminal</span>
      </>
    ),
  },
];

export function Overview() {
  return (
    <StoryCard labelWidth="420px" valueAlign="end" className="max-w-2xl">
      <StoryRow label="text primary" hint="ThreadDetailHeader git actions">
        <SplitButton
          primaryAction={commitAction}
          secondaryActions={gitSecondaries}
          mobileTitle="Thread actions"
        />
      </StoryRow>
      <StoryRow label="icon primary" hint="ThreadWorkspaceOpenButton">
        <SplitButton
          primaryAction={openInVSCodeAction}
          primaryTooltip="Open in VS Code"
          secondaryActions={editorSecondaries}
          className="px-1"
          triggerLabel="Choose another app to open workspace"
          triggerTooltip="Choose another app"
          mobileTitle="Open Workspace"
        />
      </StoryRow>
      <StoryRow label="disabled">
        <SplitButton
          primaryAction={commitAction}
          secondaryActions={gitSecondaries}
          disabled
          mobileTitle="Thread actions"
        />
      </StoryRow>
      <StoryRow label="open menu" hint="defaultOpen + modal=false">
        <SplitButton
          primaryAction={openInVSCodeAction}
          primaryTooltip="Open in VS Code"
          secondaryActions={editorSecondaries}
          className="px-1"
          triggerLabel="Choose another app to open workspace"
          triggerTooltip="Choose another app"
          mobileTitle="Open Workspace"
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
