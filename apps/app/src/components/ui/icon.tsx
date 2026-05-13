import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  AlertCircleIcon,
  Archive03Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowDownDoubleIcon,
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowMoveDownLeftIcon,
  ArrowMoveDownRightIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowShrink01Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpDoubleIcon,
  AttachmentIcon,
  AudioWaveIcon,
  BubbleChatAddIcon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  CloudIcon,
  Copy01Icon,
  DashedLineCircleIcon,
  Delete02Icon,
  Edit02Icon,
  FileQuestionMarkIcon,
  FileXIcon,
  Folder02Icon,
  FolderAddIcon,
  FolderGitTwoIcon,
  FolderIcon,
  GitMergeIcon,
  InformationCircleIcon,
  LaptopIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  LinkSquare02Icon,
  Menu02Icon,
  Mic02Icon,
  MoreHorizontalIcon,
  PlusMinusSquare01Icon,
  PlusSignIcon,
  Refresh01Icon,
  Search01Icon,
  Settings01Icon,
  SidebarBottomIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SquareIcon,
  Tick02Icon,
  Unarchive03Icon,
  UserAdd01Icon,
  UserIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

const ICON_MAP = {
  AlertCircle: AlertCircleIcon,
  AlertTriangle: Alert02Icon,
  AlignLeft: Menu02Icon,
  Archive: Archive03Icon,
  ArchiveRestore: Unarchive03Icon,
  ArrowDown: ArrowDown02Icon,
  ArrowRight: ArrowRight02Icon,
  ArrowUp: ArrowUp02Icon,
  AudioLines: AudioWaveIcon,
  Check: Tick02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  ChevronUp: ArrowUp01Icon,
  ChevronsDown: ArrowDownDoubleIcon,
  ChevronsUp: ArrowUpDoubleIcon,
  Circle: CircleIcon,
  CircleCheck: CheckmarkCircle02Icon,
  CircleDashed: DashedLineCircleIcon,
  CircleX: CancelCircleIcon,
  Columns2: LayoutTwoColumnIcon,
  Container: CloudIcon,
  Copy: Copy01Icon,
  CornerDownLeft: ArrowMoveDownLeftIcon,
  CornerDownRight: ArrowMoveDownRightIcon,
  Edit: Edit02Icon,
  ExternalLink: LinkSquare02Icon,
  FileDiff: PlusMinusSquare01Icon,
  FileQuestion: FileQuestionMarkIcon,
  FileX2: FileXIcon,
  Folder: FolderIcon,
  FolderGit2: FolderGitTwoIcon,
  FolderOpen: Folder02Icon,
  FolderPlus: FolderAddIcon,
  GitMerge: GitMergeIcon,
  Info: InformationCircleIcon,
  Laptop: LaptopIcon,
  ListTodo: CheckListIcon,
  Maximize2: ArrowExpand01Icon,
  MessageSquarePlus: BubbleChatAddIcon,
  Mic: Mic02Icon,
  Minimize2: ArrowShrink01Icon,
  MoreHorizontal: MoreHorizontalIcon,
  PanelBottom: SidebarBottomIcon,
  PanelLeft: SidebarLeftIcon,
  PanelRight: SidebarRightIcon,
  Paperclip: AttachmentIcon,
  Plus: PlusSignIcon,
  RotateCcw: Refresh01Icon,
  Rows2: LayoutTwoRowIcon,
  Search: Search01Icon,
  Settings: Settings01Icon,
  Spinner: DashedLineCircleIcon,
  Square: SquareIcon,
  Trash2: Delete02Icon,
  UserRound: UserIcon,
  UserRoundPlus: UserAdd01Icon,
  X: Cancel01Icon,
  Zap: ZapIcon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];

export interface IconProps {
  name: IconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export function Icon({
  name,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: IconProps) {
  return (
    <HugeiconsIcon
      icon={ICON_MAP[name]}
      className={cn(className)}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      data-icon={name}
    />
  );
}
