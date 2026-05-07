import { Archive, Copy, FolderOpen, Play, RotateCcw } from "lucide-react";
import { SplitButton, type SplitButtonAction } from "./split-button";

export default {
  title: "Primitives/SplitButton",
};

const primaryAction: SplitButtonAction = {
  label: "Run",
  onSelect: ignoreSelect,
  content: (
    <>
      <Play />
      Run
    </>
  ),
};

const secondaryActions: SplitButtonAction[] = [
  {
    groupLabel: "Thread",
    label: "Copy ID",
    onSelect: ignoreSelect,
    content: (
      <>
        <Copy />
        Copy ID
      </>
    ),
  },
  {
    groupLabel: "Thread",
    label: "Open workspace",
    onSelect: ignoreSelect,
    content: (
      <>
        <FolderOpen />
        Open workspace
      </>
    ),
  },
  {
    groupLabel: "Lifecycle",
    label: "Restart",
    onSelect: ignoreSelect,
    content: (
      <>
        <RotateCcw />
        Restart
      </>
    ),
  },
  {
    groupLabel: "Lifecycle",
    label: "Archive",
    onSelect: ignoreSelect,
    content: (
      <>
        <Archive />
        Archive
      </>
    ),
  },
];

export function Default() {
  return (
    <div className="flex max-w-xl items-center gap-4 p-6">
      <SplitButton
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
        mobileTitle="Thread actions"
      />
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex max-w-xl items-center gap-4 p-6">
      <SplitButton
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
        disabled
        triggerLabel="More disabled actions"
      />
    </div>
  );
}

function ignoreSelect(): void {}
