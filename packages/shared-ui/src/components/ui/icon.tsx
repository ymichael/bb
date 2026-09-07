import type { CSSProperties } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  AlertCircleIcon,
  Archive03Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BotIcon,
  BubbleChatAddIcon,
  BubbleChatIcon,
  Bug01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  DashedLineCircleIcon,
  Delete02Icon,
  Download01Icon,
  Edit02Icon,
  FolderAddIcon,
  FolderExportIcon,
  FolderGitTwoIcon,
  FolderIcon,
  HelpCircleIcon,
  InformationCircleIcon,
  Loading03Icon,
  MessageQuestionIcon,
  MoreHorizontalIcon,
  Search01Icon,
  Settings01Icon,
  SidebarLeftIcon,
  SlidersHorizontalIcon,
  SourceCodeIcon,
  Target02Icon,
  Tick02Icon,
  ToolboxIcon,
  ToolCaseIcon,
  UserAdd01Icon,
  WorkflowCircle03Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { useSyncExternalStore } from "react";
import { cn } from "../../lib/utils";
import {
  EXTENDED_ICON_NAMES,
  type ExtendedIconName,
  getExtendedIcons,
  subscribeExtendedIcons,
} from "./icon-registry";

const SectionAddStrokeRoundedIcon: IconSvgElement = [
  [
    "path",
    {
      d: "M2 3.4C2 2.24173 2.24173 2 3.4 2H20.6C21.7583 2 22 2.24173 22 3.4V4.6C22 5.75827 21.7583 6 20.6 6H3.4C2.24173 6 2 5.75827 2 4.6V3.4Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "M2 11.4C2 10.2417 2.24173 10 3.4 10H10.6C11.7583 10 12 10.2417 12 11.4V12.6C12 13.7583 11.7583 14 10.6 14H3.4C2.24173 14 2 13.7583 2 12.6V11.4Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "1",
    },
  ],
  [
    "path",
    {
      d: "M2 19.4C2 18.2417 2.24173 18 3.4 18H10.6C11.7583 18 12 18.2417 12 19.4V20.6C12 21.7583 11.7583 22 10.6 22H3.4C2.24173 22 2 21.7583 2 20.6V19.4Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "2",
    },
  ],
  [
    "path",
    {
      d: "M18 13V21M22 17H14",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: "1.5",
      key: "3",
    },
  ],
];

const CORE_ICON_MAP = {
  AlertCircle: AlertCircleIcon,
  AlertTriangle: Alert02Icon,
  Archive: Archive03Icon,
  Bot: BotIcon,
  Bug: Bug01Icon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  Circle: CircleIcon,
  CircleCheck: CheckmarkCircle02Icon,
  CircleQuestion: HelpCircleIcon,
  CircleX: CancelCircleIcon,
  ClosePluginPane: Cancel01Icon,
  CloseThreadPane: Cancel01Icon,
  Code: SourceCodeIcon,
  ComputerTerminal01: ComputerTerminal01Icon,
  Copy: Copy01Icon,
  Download: Download01Icon,
  Edit: Edit02Icon,
  Folder: FolderIcon,
  FolderExport: FolderExportIcon,
  FolderGit: FolderGitTwoIcon,
  FolderPlus: FolderAddIcon,
  Info: InformationCircleIcon,
  ListTodo: CheckListIcon,
  Loading: Loading03Icon,
  MessageQuestion: MessageQuestionIcon,
  MessageCirclePlus: BubbleChatAddIcon,
  MessageSquarePlus: BubbleChatAddIcon,
  MessageSquare: BubbleChatIcon,
  MoreHorizontal: MoreHorizontalIcon,
  PanelLeft: SidebarLeftIcon,
  Search: Search01Icon,
  SectionAdd: SectionAddStrokeRoundedIcon,
  Settings: Settings01Icon,
  SlidersHorizontal: SlidersHorizontalIcon,
  Spinner: DashedLineCircleIcon,
  Target: Target02Icon,
  Terminal: ComputerTerminal01Icon,
  Toolbox: ToolboxIcon,
  ToolCase: ToolCaseIcon,
  Trash2: Delete02Icon,
  UserRoundPlus: UserAdd01Icon,
  Workflow: WorkflowCircle03Icon,
  X: Cancel01Icon,
  Zap: ZapIcon,
} as const satisfies Record<string, IconSvgElement>;

type CoreIconName = keyof typeof CORE_ICON_MAP;

export type IconName = CoreIconName | ExtendedIconName;

const CORE_ICON_NAMES = Object.keys(CORE_ICON_MAP) as readonly CoreIconName[];

export const ICON_NAMES: readonly IconName[] = [
  ...CORE_ICON_NAMES,
  ...EXTENDED_ICON_NAMES,
];

const CORE_ICON_LOOKUP: Readonly<Record<string, IconSvgElement | undefined>> =
  CORE_ICON_MAP;

let extendedIconsLoad: Promise<void> | null = null;

export function preloadExtendedIcons(): Promise<void> {
  if (getExtendedIcons() !== null) return Promise.resolve();
  extendedIconsLoad ??= import("./icon-extended").then(
    () => undefined,
    (error: unknown) => {
      extendedIconsLoad = null;
      throw error;
    },
  );
  return extendedIconsLoad;
}

const EMPTY_ICON: IconSvgElement = [];

export interface IconProps {
  name: IconName;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({
  name,
  className,
  style,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  const coreIcon = CORE_ICON_LOOKUP[name];
  if (coreIcon !== undefined) {
    return (
      <HugeiconsIcon
        icon={coreIcon}
        className={cn(className)}
        style={style}
        aria-hidden={ariaHidden}
        aria-label={ariaLabel}
        data-icon={name}
      />
    );
  }
  return (
    <ExtendedIcon
      name={name}
      className={className}
      style={style}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
    />
  );
}

function ExtendedIcon({
  name,
  className,
  style,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  const extendedIcons: Readonly<
    Record<string, IconSvgElement | undefined>
  > | null = useSyncExternalStore(
    subscribeExtendedIcons,
    getExtendedIcons,
    getExtendedIcons,
  );
  const icon = extendedIcons?.[name];
  if (icon === undefined) {
    void preloadExtendedIcons().catch(() => undefined);
  }
  return (
    <HugeiconsIcon
      icon={icon ?? EMPTY_ICON}
      className={cn(className)}
      style={style}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
      data-icon-pending={icon === undefined ? "" : undefined}
    />
  );
}
