import { Icon, ICON_NAMES, type IconName } from "./icon";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/Icon",
};

const USAGE: Partial<Record<IconName, string>> = {
  AlertCircle: "Dialog warning state",
  AlertTriangle: "“Project folder not found” indicator on sidebar project rows",
  AlignLeft: "Mobile/coarse-pointer sidebar toggle",
  Archive: "“Archived threads” header link, archived-thread banner",
  ArchiveRestore: "Unarchive button on archived threads",
  ArrowDown: "Scroll-to-bottom button when conversation is scrolled up",
  ArrowRight: "Rename arrow in diff file headers (old → new)",
  ArrowUp: "Submit prompt button",
  AudioLines: "Voice recording indicator (pulsing) and idle wave",
  Check:
    "Selected item in pickers/menus, CopyButton confirmation, completed todo",
  ChevronDown:
    "Picker/dropdown trigger, section toggle headers, managed-child indent glyph",
  ChevronLeft: "Image lightbox previous",
  ChevronRight:
    "Sidebar row collapsed-state glyph, breadcrumb separator, lightbox next, submenu indicator, replay-capture expand",
  ChevronUp: "“Load older messages” button",
  ChevronsDown: "Git diff toolbar collapse-all",
  ChevronsUp: "Git diff toolbar expand-all",
  Circle: "Radio item indicator in menus",
  CircleCheck: "Auth callback success state",
  CircleDashed:
    "Thread row busy spinner, manager-children busy section indicator",
  CircleX: "Auth callback failure state",
  Columns2: "Git diff toolbar “split view”",
  Container:
    "Sandbox/ephemeral host icon (resolved via getHostIconName / environment helpers)",
  Copy: "CopyButton, metadata-value copy buttons",
  CornerDownLeft: "Mod+Enter submit hint in prompt footer",
  CornerDownRight:
    "Queued message indicator, steer/edit request label marker in conversation",
  Edit: "Rename project, edit queued message, edit project source",
  ExternalLink: "FilePathLink external indicator",
  FileDiff: "Secondary panel diff tab, thread changes banner section",
  FileQuestion:
    "FilePreview empty state (passed via local iconName variable)",
  FileX2:
    "FilePreview missing-file state (passed via local iconName variable)",
  Folder: "EmptyState “no projects”, sidebar project row when collapsed",
  FolderOpen: "Sidebar project row when expanded",
  FolderPlus: "(currently unused — was Add local path in project actions menu)",
  GitBranch:
    "Worktree environment icon (resolved via environment-workspace helpers)",
  GitMerge: "Branch name display, branch picker selected/option glyph",
  Info: "Secondary panel “thread info” tab, replay list info banner",
  Laptop: "Persistent host icon (resolved via getHostIconName)",
  ListTodo: "Todo section header in prompt context banner",
  Maximize2: "Enter zen mode (prompt expand)",
  MessageSquarePlus: "“New chat” button in sidebar",
  Mic: "Voice toggle in prompt",
  Minimize2: "Exit zen mode (prompt collapse)",
  MoreHorizontal:
    "Triple-dot actions menu trigger (projects, threads, project sources, hosts)",
  PanelBottom: "Toggle secondary panel as bottom drawer (compact viewport)",
  PanelLeft: "Sidebar toggle (desktop / fine pointer)",
  PanelRight:
    "Toggle secondary panel (desktop / non-drawer; resolved via togglePanelIconName)",
  Paperclip: "Attach files button",
  Plus: "New project button, “new branch” option in branch picker",
  RotateCcw: "Retry button when fetching timeline turn details fails",
  Rows2: "Git diff toolbar “unified view”",
  Search: "Picker search inputs, file tree search, branch picker filter",
  Settings: "App settings link in sidebar, project settings link in header",
  Spinner: "All loading / pending states",
  Square: "Stop button while running, in-progress and pending todo glyphs",
  Trash2:
    "Delete queued message, remove project source, delete replay capture",
  UserRound:
    "Manager indicator in sidebar, “Managed by” indicators in prompt banner",
  UserRoundPlus: "“New Manager” button in sidebar",
  X: "Close dialogs/drawers, clear search input, remove attachment, close metadata panel",
  Zap: "Fast-mode indicator in model picker trigger, Fast-mode toggle row",
};

const NAMES: readonly IconName[] = [...ICON_NAMES].sort();

export function Overview() {
  return (
    <StoryCard labelWidth="280px">
      {NAMES.map((name) => (
        <StoryRow key={name} label={name} hint={USAGE[name] ?? null}>
          <Icon name={name} className="size-5" />
        </StoryRow>
      ))}
    </StoryCard>
  );
}
